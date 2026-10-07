const readline = require('readline');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { makeClient, sleep, dmy, mins, stamp, BASE, LOC, AREAS, UA, CARD_ID } = require('./lib/client');
const { openSession, getExcludedDays, getSlots, xhrHeaders, reservationCodes } = require('./lib/site');
const { tg, resolveChat, drainUpdates } = require('./lib/telegram');
const { withStickySession } = require('./lib/proxy');

const STATE_FILE = path.join(__dirname, 'state.json');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PROXY = process.env.PROXY || '';
const PROXY_PORT = Number(process.env.PROXY_PORT || 4100);
const SCAN_DAYS = Number(process.env.SCAN_DAYS || 60);
// The site answers only about 2 add-to-cart requests per second for all its visitors
// together (measured 2026-10-05: 1 in parallel → 1.3/s, 3 → 2.0/s, 6 → 2.3/s, while a
// client on another IP slowed from 0.7s to 5s per request). More parallel requests add
// almost no tries; they slow the site for everyone, our own checkout included. So all
// hunts share one small budget of requests in flight, and the cap is deliberate.
const WORKERS = Math.min(4, Math.max(1, Number(process.env.SNIPE_WORKERS || 3)));
const RUSH_SHOTS = WORKERS + 2;
const RUSH_MS = 6000;
// Re-hold team: sessions opened a few minutes ahead and kept idle until the re-hold.
const TEAM_SIZE = 5;
// Shooters that did not win are kept for the next re-hold, up to this age.
const TEAM_MAX_AGE_MS = 25 * 60e3;
// Re-hold shooters connect from the server itself: the proxy adds latency to every shot
// (direct: the rival won 4 of 9 re-holds; through the proxy: 5 of 8).
const REHOLD_DIRECT = process.env.REHOLD_DIRECT !== 'false';
const TEAM_LEAD_MS = 4 * 60e3;
// When someone takes our seats, their own hold ends 15 min later unless they pay.
const CATCHUP_AT_MS = 14.5 * 60e3;
const CATCHUP_RUSH_MS = 75e3;
const GAP_MS = Math.max(0, Number(process.env.SNIPE_GAP_MS || 0));
const KEEPALIVE_MS = Number(process.env.REHOLD_SEC || 780) * 1000;
const MAX_QTY = 7;
const HOLD_TTL_MS = 15 * 60e3;
const CHECKOUT_ACTIVE_MS = 2 * 60e3;
const SESSION_MAX_MS = 10 * 60e3;
const CM_GAP_MIN = 60;
const CM_SECURE_MS = 10 * 60e3;
const SLOT_CACHE_MS = 10 * 60e3;
const CALENDAR_MAX_MS = 30 * 60e3;
const PROBE_MS = 15e3;
const MAX_QUICK_RENEWALS = 5;
// Re-holds running at the same time slow each other down (measured over 1,160 re-holds:
// median 10s alone, 40s with three or more at once), and a slow in-place re-hold leaves
// the seats free longer. So only this many run at once, and their start times are spread.
const MAX_REHOLDS = 2;
const REHOLD_SPACING_MS = 25e3;
const QUICK_RETRIES = 2;
const CARD_CODE = '40.04.23';

// ── State ──────────────────────────────────────────────
// A job is one target (date + Colosseo time + ticket count). It hammers the slot until it
// catches the tickets, keeps them, and goes back to hammering if they are ever lost.
// It ends only when someone stops it, marks it paid, or the slot time passes.
const S = {
  excluded: new Set(),
  calendarAt: 0,
  slots: new Map(),
  jobs: [],
  nextId: 1,
  chats: new Set(),
  owner: null,
  offset: 0,
  menuMsgs: {},
  scoutClient: null,
  scoutCsrf: null,
  proxyDownUntil: 0,
  proxyFails: 0,
  proxyWarned: false,
  workers: new Set(),
  stopping: false,
  lastStart: null,
};

const log = (m) => console.log(`${stamp()} ${m}`);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const tickets = (n) => `${n} ticket${n === 1 ? '' : 's'}`;
const newToken = () => crypto.randomBytes(9).toString('base64url');
const CHECKOUT_URL = `${BASE}/${LOC}/vouchers/checkout`;

function errText(e) {
  const parts = [];
  for (let x = e; x && parts.length < 4; x = x.cause) parts.push(x.message || String(x));
  return parts.join(' ← ');
}

// The site runs on Rome time, whatever the server's clock zone is.
const romeNow = () => new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Rome' }).slice(0, 16);
const isPast = (date, time) => `${date} ${time}` <= romeNow();

function upcomingDays(n = SCAN_DAYS) {
  const [y, m, d] = romeNow().slice(0, 10).split('-').map(Number);
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10));
}

// ── Telegram basics ────────────────────────────────────
const tgSend = (method, body) => (TOKEN ? tg(TOKEN, method, body) : Promise.resolve({ ok: true }));

// For messages that must arrive: retries network failures and waits out Telegram's rate limit.
async function tgSure(method, body) {
  let r = null;
  for (let i = 0; i < 4; i++) {
    r = await tgSend(method, body).catch(() => null);
    if (r && r.error_code !== 429) return r;
    await sleep(((r?.parameters?.retry_after || 2) + 1) * 1000);
  }
  return r;
}

function tgNotify(text, kb) {
  for (const c of S.chats) {
    tgSure('sendMessage', { chat_id: c, text, parse_mode: 'HTML', ...(kb ? { reply_markup: kb } : {}) });
  }
}

// ── Proxy ──────────────────────────────────────────────
function nextProxy() {
  if (!PROXY || Date.now() < S.proxyDownUntil) return null;
  return withStickySession(PROXY);
}

// The proxy is failing: use the server's own IP for 5 minutes, then try it again.
function proxyDown(why) {
  if (!PROXY || Date.now() < S.proxyDownUntil) return;
  S.proxyDownUntil = Date.now() + 5 * 60e3;
  S.proxyFails = 0;
  log(`⚠️ Proxy problem (${why}). Using the server IP for 5 min.`);
  if (!S.proxyWarned) {
    S.proxyWarned = true;
    tgNotify(`⚠️ <b>Proxy problem</b>: ${esc(why)}\nWorking from the server IP until the proxy answers again.`);
  }
}

// Returns a short reason for logs and status lines.
function noteError(e) {
  const msg = errText(e);
  if (/Proxy response \(402\)/.test(msg)) proxyDown('402, out of credit?');
  return msg.length > 80 ? `${msg.slice(0, 80)}…` : msg;
}

// ── Persistence ────────────────────────────────────────
// The cart page redirects to the site's own home page when the cart is empty. A redirect
// anywhere else (a bot-check page, for example) says nothing about the cart.
const cartIsEmpty = (r) => r.status === 302 && (r.location.startsWith('/') || r.location.startsWith(BASE));

function saveState() {
  // While jobs are being restored the file still holds ones not loaded yet.
  if (S.restoring) return;
  const data = {
    nextId: S.nextId,
    chats: [...S.chats],
    jobs: S.jobs.filter((j) => j.state !== 'done').map((j) => ({
      id: j.id, token: j.token, date: j.date, clSlot: j.clSlot, cmSlots: j.cmSlots, qty: j.qty,
      startedAt: j.startedAt, attempts: j.attempts, msgs: j.msgs,
      held: j.state === 'held' ? {
        cmSlot: j.cmSlot, codes: j.codes, cookies: j.client.jar, csrf: j.csrf,
        proxyUrl: j.proxyUrl, heldAt: j.heldAt, paying: j.paying, cart: j.cart, have: j.have, batches: j.batches,
      } : null,
    })),
  };
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

async function loadState() {
  if (!fs.existsSync(STATE_FILE)) return;
  let data;
  try { data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) {
    log(`⚠️ state.json unreadable (${e.message}) — starting empty`);
    return;
  }
  S.nextId = data.nextId || 1;
  for (const c of data.chats || []) S.chats.add(c);
  if (!data.jobs?.length) return;

  log(`Restoring ${data.jobs.length} job(s)...`);
  S.restoring = true;
  for (const d of data.jobs) {
    if (isPast(d.date, d.clSlot.time)) {
      log(`  ⌛ ${d.qty}× ${d.date} ${d.clSlot.time} — time passed, dropped`);
      continue;
    }
    const job = makeJob(d);
    Object.assign(job, {
      id: d.id, token: d.token || newToken(), startedAt: d.startedAt || Date.now(),
      attempts: d.attempts || 0, prevAttempts: d.attempts || 0, msgs: d.msgs || [],
    });
    S.nextId = Math.max(S.nextId, job.id + 1);
    S.jobs.push(job);
    const h = d.held;
    if (h && Date.now() - h.heldAt < HOLD_TTL_MS) {
      const client = makeClient(h.proxyUrl || null);
      Object.assign(client.jar, h.cookies);
      // Only an empty cart proves the hold is gone; on errors it is kept and the
      // regular check decides later.
      let gone = false;
      for (let i = 0; i < 3; i++) {
        try { gone = cartIsEmpty(await client.http('GET', CHECKOUT_URL)); break; } catch { await sleep(1000); }
      }
      if (!gone) {
        job.paying = h.paying || 0;
        setHeld(job, { client, csrf: h.csrf, proxyUrl: h.proxyUrl }, h.cmSlot, h.codes, h.heldAt, h.cart, h.have || d.qty);
        // Unknown for carts saved by an older version: assume several, the cautious case.
        job.batches = h.batches || 2;
        log(`  ✅ ${jobName(job)} still held, ${job.have}/${job.qty} (${ttlStr(job)} left)${job.paying ? ' — payment started, re-holding paused' : ''}`);
        continue;
      }
      client.close();
    }
    if (h) {
      log(`  ⚠️ ${jobName(job)} hold was lost while offline`);
      job.huntReason = 'lost';
      tgNotify(`⚠️ <b>Lost ${jobName(job)}</b> while the bot was offline\n🎯 Hammering the slot again...`);
    }
    log(`  🎯 ${jobName(job)} — hunting`);
    hunt(job);
  }
  S.restoring = false;
  saveState();
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

// ── Scout session (shared, read-only) ──────────────────
async function ensureScout() {
  if (S.scoutClient) return;
  const client = makeClient(nextProxy());
  try {
    const { csrf } = await openSession(client, { adults: 1 });
    S.scoutClient = client;
    S.scoutCsrf = csrf;
  } catch (e) {
    client.close();
    throw e;
  }
}

async function resetScout() {
  if (S.scoutClient) S.scoutClient.close();
  S.scoutClient = null;
  await ensureScout();
}

async function withScout(fn) {
  try {
    await ensureScout();
    return await fn(S.scoutClient, S.scoutCsrf);
  } catch (e) {
    noteError(e);
    await resetScout();
    return fn(S.scoutClient, S.scoutCsrf);
  }
}

// ── Calendar & slots ───────────────────────────────────
// Every day is listed; the site's blocked days (sold out or closed) are only marked.
async function refreshCalendar() {
  log('Fetching calendar...');
  const [exCM, exCL] = await withScout(async (c, csrf) => {
    const a = await getExcludedDays(c, csrf, 'CM');
    await sleep(200);
    return [a, await getExcludedDays(c, csrf, 'CL')];
  });
  S.excluded = new Set([...exCM, ...exCL]);
  S.calendarAt = Date.now();
  S.slots.clear();
  log(`Calendar: ${upcomingDays().filter((d) => S.excluded.has(d)).length} of the next ${SCAN_DAYS} days are blocked by the site`);
}

// number_of_pax=0 makes get_availability list every slot, including full ones.
// With showOpen, one extra request (sent alongside the others, so the menu is no slower)
// asks which Colosseo times have a free seat right now. That is only for the menu's 🟢
// marks: it is read once when a day is opened and never checked again by a hunt.
async function fetchSlots(date, showOpen = false) {
  const cached = S.slots.get(date);
  if (cached && Date.now() - cached.at < SLOT_CACHE_MS && (!showOpen || cached.open)) return cached;
  const data = await withScout(async (c, csrf) => {
    const [cl, cm, free] = await Promise.all([
      getSlots(c, csrf, 'CL', date, 0),
      getSlots(c, csrf, 'CM', date, 0),
      showOpen ? getSlots(c, csrf, 'CL', date, 1).catch(() => null) : null,
    ]);
    return { cl, cm, at: Date.now(), open: free ? new Set(free.map((x) => x.time)) : cached?.open || null };
  });
  S.slots.set(date, data);
  return data;
}

const openMark = (day, slot) => (day.open?.has(slot.time) ? '🟢 ' : '');

// CM times at least 60 min before the CL time, closest first.
function cmCandidates(cmSlots, clSlot) {
  return cmSlots
    .filter((s) => mins(clSlot.time) - mins(s.time) >= CM_GAP_MIN)
    .sort((a, b) => mins(b.time) - mins(a.time));
}

// ── Site operations ────────────────────────────────────
// The session's party size must equal the ticket count, or the cart comes out broken.
async function newSession(qty, { direct = false } = {}) {
  const proxyUrl = direct ? null : nextProxy();
  const client = makeClient(proxyUrl);
  try {
    const { csrf } = await openSession(client, { adults: qty });
    if (proxyUrl) { S.proxyFails = 0; S.proxyWarned = false; }
    return {
      client, csrf, proxyUrl, qty,
      bornAt: Date.now(), maxAge: SESSION_MAX_MS * (0.8 + 0.4 * Math.random()),
    };
  } catch (e) {
    client.close();
    if (proxyUrl && ++S.proxyFails >= 5) proxyDown('5 sessions in a row failed through it');
    throw e;
  }
}

const stripTags = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// The reply re-renders the session's cart for that area, so `codes` lists whatever the
// session holds after the call, including holds made by earlier (even failed) requests.
// `ok` means the site answered normally; ok with no codes is a real "full".
async function addToCart(sess, date, area, slot, qty) {
  const r = await sess.client.http('POST', `${BASE}/${LOC}/vouchers/create_or_update`, {
    headers: xhrHeaders(sess.csrf),
    form: {
      buy_area: area, buy_reservation_date: dmy(date), buy_group_name: slot.id,
      buy_products: `${AREAS[area].code}_${qty}`, multibook: 'multitickets',
    },
  });
  let j = null;
  try { j = JSON.parse(r.text); } catch {}
  const ok = r.status === 200 && typeof j?.html === 'string';
  return {
    ok,
    codes: ok ? reservationCodes(j.html) : [],
    text: ok ? stripTags(j.html) : '',
    dead: r.status === 404 || r.status === 422,
    why: ok ? '' : j?.hold === 'ko' ? 'refused by the site (hold: ko)' : `unexpected reply (HTTP ${r.status})`,
  };
}

// Frees reservations. Each area is retried, because a release that silently fails
// leaves the seats locked in a session nobody uses until the 15 minutes run out.
async function deleteCodes(sess, codes) {
  if (!sess?.client || !codes?.length) return;
  await Promise.all(['CL', 'CM'].map(async (area) => {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await sess.client.http('POST', `${BASE}/${LOC}/vouchers/delete_reservations`, {
          headers: xhrHeaders(sess.csrf), form: { reservations: codes.join('**'), buy_area: area },
        });
        const still = reservationCodes(JSON.parse(r.text).html);
        if (r.status === 200 && !codes.some((c) => still.includes(c))) return;
      } catch {}
      await sleep(500);
    }
  }));
}

// The fastest possible release for a re-hold: ONE request (it frees every code in the
// cart, measured), resolving the moment its reply arrives, which is when the shooters
// fire. If that reply does not confirm the codes are gone, the full release runs.
async function releaseFast(sess, codes) {
  try {
    const r = await sess.client.http('POST', `${BASE}/${LOC}/vouchers/delete_reservations`, {
      headers: xhrHeaders(sess.csrf), form: { reservations: codes.join('**'), buy_area: 'CL' },
    });
    const still = reservationCodes(JSON.parse(r.text).html);
    if (r.status === 200 && !codes.some((c) => still.includes(c))) return;
  } catch {}
  await deleteCodes(sess, codes);
}

// A code in a reply is not proof; the checkout page is. The cart counts only if that
// page lists every reservation we think we hold. If the page cannot be read at all the
// catch is kept, marked as not checked.
async function verifyCart(sess, codes) {
  for (let i = 0; i < 3; i++) {
    let r;
    try { r = await sess.client.http('GET', CHECKOUT_URL); } catch { await sleep(1000); continue; }
    if (cartIsEmpty(r)) return { ok: false, why: 'the site gave codes but the cart is empty' };
    // Anything that is not the real checkout page (it carries the pay form) proves nothing.
    if (r.status !== 200 || !r.text.includes('/vouchers/pay')) { await sleep(1000); continue; }
    const missing = codes.filter((c) => !r.text.includes(c));
    if (missing.length) return { ok: false, why: `the cart does not list ${missing.join(', ')}` };
    const text = r.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    return {
      ok: true, checked: true,
      people: Number((text.match(/(\d+)\s+persona\/e/) || [])[1] || 0),
      total: (text.match(/Totale:\s*([\d.,]+)/) || [])[1] || '',
    };
  }
  return { ok: true, checked: false };
}

// ── Shared request budget ──────────────────────────────
const gate = { free: WORKERS, waiting: [] };
function acquire() {
  if (gate.free > 0) { gate.free--; return Promise.resolve(); }
  return new Promise((r) => gate.waiting.push(r));
}
function release() {
  const next = gate.waiting.shift();
  if (next) next(); else gate.free++;
}

// A job re-catching its own seats goes first: its shots skip the budget and every
// other hunt holds its fire until the rush is over.
const rushing = (job) => job.rushUntil > Date.now();
const othersRushing = (job) => S.jobs.some((j) => j !== job && rushing(j));
// Someone is on a checkout page: hunts back off so the site answers them faster.
const checkoutBusy = () => S.jobs.some((j) => j.state === 'held' && Date.now() - j.lastProxyAt < 60e3);

// ── Jobs ───────────────────────────────────────────────
function makeJob({ date, clSlot, cmSlots, qty }) {
  return {
    id: 0, token: newToken(), date, clSlot, cmSlots, qty,
    state: 'hunting', gen: 0, huntReason: 'new',
    attempts: 0, prevAttempts: 0, startedAt: Date.now(), lastResult: '—', lastMs: 0, bad: 0, msgs: [],
    client: null, csrf: null, proxyUrl: null, cmSlot: null, codes: [], heldAt: 0, cart: null,
    timer: null, busy: false, paying: 0, lastProxyAt: 0, swapAt: 0, rushUntil: 0,
    // Stacking: tickets in the cart so far, people announced to the site but not booked
    // yet, and a queue that keeps work on the cart session one step at a time.
    have: 0, pending: 0, batches: 1, renewals: 0, team: [], teamTimer: null, catchupTimer: null, swapHave: 0,
    chain: Promise.resolve(), topping: null, topTries: 0, topLast: '—', swapFulls: 0,
  };
}

const jobName = (job) => `${job.qty}× ${job.date} ${job.clSlot.time}`;
const liveJobs = () => S.jobs.filter((j) => j.state !== 'done');
const heldJobs = () => S.jobs.filter((j) => j.state === 'held');
const huntingJobs = () => S.jobs.filter((j) => j.state === 'hunting' || j.state === 'securing');

async function startJob(date, clSlot, qty) {
  if (isPast(date, clSlot.time)) throw new Error(`${date} ${clSlot.time} is already in the past`);
  const day = await fetchSlots(date);
  if (!cmCandidates(day.cm, clSlot).length) {
    throw new Error(`No Carcere time is ${CM_GAP_MIN}+ min before ${clSlot.time}`);
  }
  const job = makeJob({ date, clSlot, cmSlots: day.cm, qty });
  job.id = S.nextId++;
  S.jobs.push(job);
  log(`🎯 Hunting ${jobName(job)}`);
  hunt(job);
  // The hunt does not wait for Telegram. If it is already over when a status message
  // goes out, that message is closed instead of being tracked.
  for (const c of S.chats) {
    if (job.huntReason !== 'new') break;
    const r = await tgSure('sendMessage', {
      chat_id: c, parse_mode: 'HTML', text: huntText(job), reply_markup: stopKb(job),
    });
    const msgId = r?.result?.message_id;
    if (!msgId) continue;
    if (job.huntReason === 'new' && job.state !== 'done') job.msgs.push({ chatId: c, msgId });
    else tgSure('editMessageText', { chat_id: c, message_id: msgId, text: `🎯 ${jobName(job)} — see the newer message` });
  }
  return job;
}

// Closes a session. After failed requests it may hold seats nobody knows about, so the
// cart page is checked first and anything found there is freed.
async function dropSession(sess, suspect) {
  if (suspect) {
    try {
      const r = await sess.client.http('GET', CHECKOUT_URL);
      const codes = r.status === 200 ? [...new Set(r.text.match(/\bRS[A-Z]{2}\d{6,}[A-Z]\b/g) || [])] : [];
      if (codes.length) {
        log(`🧹 Freed seats left behind by a failed request (${codes.join(', ')})`);
        await deleteCodes(sess, codes);
      }
    } catch {}
  }
  sess.client.close();
}

// Starts the workers that hammer the Colosseo slot; bumping job.gen stops them.
// A plain hunt spreads the first shots over one request cycle. A re-hold (`freed` is
// the pending release request) sends half of its shots with the release and the other
// half the moment the site confirms it, 150 ms apart; the sessions beyond WORKERS are
// only for that rush and drop out after RUSH_MS.
function hunt(job, warm = [], freed = null) {
  if (job.state === 'done') { warm.forEach((s) => s.client.close()); return; }
  clearTimeout(job.timer);
  job.state = 'hunting';
  job.paying = 0;
  const gen = ++job.gen;
  const n = Math.max(WORKERS, warm.length);
  const step = Math.round(Math.min(1500, Math.max(300, job.lastMs || 800)) / n);
  // Shots fired before the release reply only slowed the site at the decisive moment
  // (measured: the rival won 4 of 9 with them, 2 of 8 without), so there are none.
  const preShots = 0;
  for (let i = 0; i < n; i++) {
    const start = {
      // A stuck release must not hold the second half back for long.
      // Re-hold: shooter 0 fires with the release and keeps firing; the rest fire the
      // instant its reply arrives (40 ms apart), when the seat has just come free.
      after: freed && i > preShots ? Promise.race([freed, sleep(3000)]) : null,
      delay: !freed ? i * step : i === 0 ? 0 : i <= preShots ? 250 + (i - 1) * 200 : (i - preShots - 1) * 40,
      extra: i >= WORKERS,
      rehold: !!freed,
    };
    const p = huntWorker(job, gen, warm[i] || null, start)
      .catch((e) => log(`⚠️ worker crashed: ${errText(e)}`))
      .finally(() => S.workers.delete(p));
    S.workers.add(p);
  }
  // A plain hunt with nothing yet takes smaller openings. A re-hold that does not land
  // checks whether someone took part of the seats, and keeps what is left.
  const scout = !freed && !job.have && job.qty > 1 ? { max: job.qty - 1 }
    : freed && job.have > 1 ? { max: job.have, firstDelay: 2500, partialOnly: true } : null;
  if (scout) {
    const p = partialScout(job, gen, scout)
      .catch((e) => log(`⚠️ scout crashed: ${errText(e)}`))
      .finally(() => S.workers.delete(p));
    S.workers.add(p);
  }
  saveState();
}

async function huntWorker(job, gen, sess, { after, delay, extra, rehold }) {
  const mine = () => job.gen === gen && job.state === 'hunting';
  // A re-hold that has just freed its seats keeps firing even during shutdown.
  const quitting = () => S.stopping && !rushing(job);
  // A re-hold asks for exactly what the cart had; a fresh hunt asks for everything.
  const want = job.have || job.qty;
  if (after) await after;
  if (delay) await sleep(delay);
  // After an errored request the hold may exist anyway, so the session is only dropped
  // once a later reply (which would show the hold) or three failures have settled it.
  // suspectAt is when the first unresolved failure was sent: a hold found later dates from then.
  let strikes = 0;
  let suspectAt = 0;
  while (mine()) {
    if (!strikes && (quitting() || (extra && !rushing(job)))) break;
    try {
      // (Re-hold shooters are exempt: replacing one now would make it miss its moment.)
      if (sess && !strikes && !rehold && Date.now() - sess.bornAt > sess.maxAge) { sess.client.close(); sess = null; }
      if (!sess) sess = await newSession(want);
      const rush = rushing(job);
      if (!rush) {
        while (mine() && othersRushing(job)) await sleep(50);
        if (checkoutBusy()) await sleep(1500);
        await acquire();
      }
      let r;
      let t0;
      try {
        if (!mine() || (!strikes && quitting())) break;
        t0 = Date.now();
        if (!suspectAt) suspectAt = t0;
        r = await addToCart(sess, job.date, 'CL', job.clSlot, want);
      } finally {
        if (!rush) release();
      }
      job.attempts++;
      job.lastMs = Date.now() - t0;
      if (r.codes.length) {
        t0 = suspectAt;
        strikes = 0;
        if (!mine()) { await deleteCodes(sess, r.codes); break; }
        // Caught: this worker owns the job now; the others stop on their next check.
        job.state = 'securing';
        job.gen++;
        job.bad = 0;
        job.rushUntil = 0;
        log(`🎉 Caught ${want}× Colosseo ${job.clSlot.time} on ${job.date} after ${job.attempts.toLocaleString('en')} tries — adding Carcere...`);
        job.caughtReplyAt = Date.now();
        const won = sess;
        sess = null;
        await secure(job, won, r.codes, t0, want);
        return;
      }
      if (r.ok) {
        strikes = 0;
        suspectAt = 0;
        job.bad = 0;
        job.lastResult = 'full';
        job.swapFulls++;
        if (GAP_MS) await sleep(GAP_MS);
        continue;
      }
      job.lastResult = r.why;
      job.bad++;
      if (r.dead || ++strikes >= 3) { await dropSession(sess, true); sess = null; strikes = 0; suspectAt = 0; }
      await sleep(1000);
    } catch (e) {
      job.lastResult = `error: ${noteError(e)}`;
      job.bad++;
      if (sess && ++strikes >= 3) { await dropSession(sess, true); sess = null; strikes = 0; suspectAt = 0; }
      await sleep(1000);
    }
  }
  if (!sess) return;
  // A re-hold shooter that lost is still a clean, ready session: keep it for next time.
  if (rehold && !strikes && sess.qty && Date.now() - sess.bornAt < TEAM_MAX_AGE_MS
      && (job.state === 'securing' || job.state === 'held') && job.team.length < TEAM_SIZE) {
    job.team.push(sess);
    return;
  }
  await dropSession(sess, strikes > 0);
}

// Adds the Carcere half to the cart that already holds the Colosseo tickets, then
// checks the real cart before calling it secured.
async function secure(job, sess, clCodes, caughtAt, qty) {
  const cands = cmCandidates(job.cmSlots, job.clSlot);
  const deadline = caughtAt + CM_SECURE_MS;
  let codes = clCodes;
  let why = `no Carcere time had ${qty} seats`;
  try {
    scan:
    while (job.state === 'securing' && Date.now() < deadline) {
      for (const cm of cands) {
        // Two tries per time: an errored request may still have made the hold, and the
        // second reply shows it, so the hold is credited to the right time.
        for (let k = 0; k < 2 && job.state === 'securing'; k++) {
          let r;
          try { r = await addToCart(sess, job.date, 'CM', cm, qty); } catch (e) { noteError(e); continue; }
          codes = [...new Set([...codes, ...r.codes])];
          if (r.ok) break;
        }
        if (job.state !== 'securing') break scan;
        if (codes.length < 2) continue;
        const cart = await verifyCart(sess, codes);
        if (!cart.ok) { why = cart.why; break scan; }
        if (job.state !== 'securing') break scan;
        setHeld(job, sess, cm, codes, caughtAt, cart, qty);
        onCaught(job);
        return;
      }
      await sleep(1000);
    }
  } finally {
    if (job.client !== sess.client) {
      await deleteCodes(sess, codes);
      sess.client.close();
      if (job.state === 'securing') {
        log(`⚠️ ${jobName(job)}: ${why} — hunting again`);
        if (!job.secureWarned) {
          job.secureWarned = true;
          tgNotify(`⚠️ <b>${jobName(job)}</b>: caught the Colosseo seats but could not finish the cart (${esc(why)}).\n🎯 Hammering again...`);
        }
        hunt(job);
      }
    }
  }
}

function setHeld(job, sess, cmSlot, codes, heldAt, cart, have) {
  Object.assign(job, {
    state: 'held', client: sess.client, csrf: sess.csrf, proxyUrl: sess.proxyUrl,
    cmSlot, codes, heldAt, cart: cart || null, have, pending: 0, batches: 1, renewals: 0,
  });
  job.quickRetries = 0;
  if (!job.paying) scheduleKeepAlive(job, planRehold(job));
  scheduleTeam(job);
  saveState();
  startTopUp(job);
}

// ── Re-hold team ───────────────────────────────────────
// A few sessions are opened shortly before each re-hold and left idle, so at the re-hold
// itself no time goes into opening them and they have not been slowed by earlier use.
// They are sorted by how fast they opened: the fastest fires the first shot.
function scheduleTeam(job) {
  clearTimeout(job.teamTimer);
  const wait = job.heldAt + KEEPALIVE_MS - TEAM_LEAD_MS - Date.now();
  job.teamTimer = setTimeout(() => prepareTeam(job).catch((e) => log(`⚠️ team: ${errText(e)}`)), Math.max(1000, wait));
}

async function prepareTeam(job) {
  if (job.state !== 'held' || job.paying || S.stopping) return;
  // Sessions announce a party size; ones made for another size, or too old, go.
  const keep = (x) => x.qty === job.have && Date.now() - x.bornAt < TEAM_MAX_AGE_MS;
  for (const t of job.team.filter((x) => !keep(x))) t.client.close();
  job.team = job.team.filter(keep);
  while (job.team.length < TEAM_SIZE && job.state === 'held' && !S.stopping) {
    const t0 = Date.now();
    try {
      const sess = await newSession(job.have, { direct: REHOLD_DIRECT });
      sess.openMs = Date.now() - t0;
      if (job.state !== 'held') { sess.client.close(); break; }
      job.team.push(sess);
    } catch (e) {
      noteError(e);
      await sleep(2000);
    }
  }
  job.team.sort((a, b) => (a.openMs || 9e9) - (b.openMs || 9e9));
  if (job.team.length) {
    log(`🧰 ${jobName(job)}: ${job.team.length} shooters ready for the re-hold (open times ${job.team.map((t) => t.openMs).join('/')}ms)`);
  }
}

function dropTeam(job) {
  clearTimeout(job.teamTimer);
  for (const t of job.team || []) t.client.close();
  job.team = [];
}

const teamReady = (job) => job.team.filter((x) => x.qty === job.have).length >= 2;

// Someone took our seats at `at`. Unless they pay, their hold ends 15 minutes later:
// a burst of extra shooters then, on top of the normal hunt, takes the seats back.
function scheduleCatchup(job, at) {
  clearTimeout(job.catchupTimer);
  job.catchupTimer = setTimeout(() => catchupBurst(job).catch((e) => log(`⚠️ catchup: ${errText(e)}`)),
    Math.max(1000, at + CATCHUP_AT_MS - Date.now()));
  log(`⏰ ${jobName(job)}: catchup burst planned for ${new Date(at + CATCHUP_AT_MS).toTimeString().slice(0, 8)}`);
}

async function catchupBurst(job) {
  if (job.state !== 'hunting' || S.stopping) return;
  const want = job.have || job.qty;
  const warm = [];
  for (let i = 0; i < TEAM_SIZE; i++) {
    try { warm.push(await newSession(want)); } catch (e) { noteError(e); }
  }
  if (job.state !== 'hunting') { warm.forEach((x) => x.client.close()); return; }
  log(`⏰ ${jobName(job)}: catchup burst — ${warm.length} extra shooters for ${CATCHUP_RUSH_MS / 1000}s`);
  job.rushUntil = Date.now() + CATCHUP_RUSH_MS;
  hunt(job, warm);
}

async function onCaught(job) {
  const reason = job.huntReason;
  job.huntReason = null;
  const c = job.cart;
  log(`✅ SECURED ${job.have}/${job.qty} of ${jobName(job)} + Carcere ${job.cmSlot.time} — ${job.codes.join(', ')}` +
    ` — cart ${c?.checked ? `checked: ${c.people} people, ${c.total} €` : 'not checked'} — ${checkoutLink(job)}`);
  if (reason === 'swap') {
    const lost = job.swapHave - job.have;
    log(`♻️ Re-held ${job.have} of ${jobName(job)} by hand-over: seats back ${job.caughtReplyAt - job.swapAt}ms after the release was sent`);
    editJobMsgs(job, heldText(job, lost > 0 ? `⚠️ ${lost} seat(s) taken during the re-hold — stacking to get them back` : '♻️ Re-held, timer reset'), heldKb(job));
    if (lost > 0) {
      log(`⚠️ ${jobName(job)}: ${lost} seat(s) taken during the re-hold, kept ${job.have}`);
      tgNotify(`⚠️ <b>${jobName(job)}</b>: someone took ${lost} seat(s) during the re-hold.\nKept ${job.have}, stacking to get the rest back.`);
      scheduleCatchup(job, job.swapAt);
    }
    return;
  }
  editJobMsgs(job, `✅ Caught ${job.have} of ${jobName(job)} after ${job.attempts.toLocaleString('en')} tries — details below 👇`);
  job.msgs = [];
  for (const chat of S.chats) {
    const r = await tgSure('sendMessage', {
      chat_id: chat, parse_mode: 'HTML', text: heldText(job), reply_markup: heldKb(job),
    });
    if (r?.result?.message_id) job.msgs.push({ chatId: chat, msgId: r.result.message_id });
  }
  saveState();
}

// ── Stacking ───────────────────────────────────────────
// One cart can take several batches: announce a party size (set_pax), then book it.
// Each announced person is added to the cart total at once, booked or not, so a batch
// that is announced but not booked ("pending") must be removed before anyone sees the
// checkout page. After the first batch the add-to-cart reply no longer lists new codes;
// a catch shows as a changed reply text and is confirmed on the cart page.

// Runs fn alone on the job's cart session, after whatever is already queued.
function withCart(job, fn) {
  const run = job.chain.then(fn, fn);
  job.chain = run.catch(() => {});
  return run;
}

async function setPax(sess, n) {
  const r = await sess.client.http('POST', `${BASE}/${LOC}/cards/set_pax`, {
    form: {
      utf8: '✓', authenticity_token: sess.csrf, card: CARD_ID, locale: LOC, max_limit: 7, min_limit: 0,
      adult: n, child: 0, student: 0, newborn: 0, commit: 'Acquista',
    },
  });
  if (r.status !== 302) throw new Error(`set_pax answered HTTP ${r.status}`);
}

async function cartInfo(sess) {
  const r = await sess.client.http('GET', CHECKOUT_URL);
  if (cartIsEmpty(r)) throw new Error('the cart is empty');
  if (r.status !== 200 || !r.text.includes('/vouchers/pay')) throw new Error(`cart page answered HTTP ${r.status}`);
  const text = stripTags(r.text);
  return {
    codes: [...new Set(r.text.match(/\bRS[A-Z]{2}\d{6,}[A-Z]\b/g) || [])],
    people: Number((text.match(/(\d+)\s+persona\/e/) || [])[1] || 0),
    total: (text.match(/Totale:\s*([\d.,]+)/) || [])[1] || '',
  };
}

// Removes people that are announced but not booked, judged from the cart page itself.
// Call it inside withCart.
async function cleanCart(job) {
  if (!job.client) return null;
  const sess = { client: job.client, csrf: job.csrf };
  let info = await cartInfo(sess);
  const extra = info.people - job.have;
  if (extra > 0) {
    const r = await sess.client.http('POST', `${BASE}/${LOC}/vouchers/delete_item`, {
      form: { utf8: '✓', authenticity_token: sess.csrf, code: CARD_CODE, qta: extra },
    });
    if (r.status !== 302) throw new Error(`delete_item answered HTTP ${r.status}`);
    info = await cartInfo(sess);
  }
  job.pending = 0;
  return info;
}

// After a re-hold has booked the new seats, reads the cart until it gives a clear answer.
// A slow or odd read is never a reason to give the seats up: only a cart proven not to
// hold them (empty, or a real cart page without them) is. Call it inside withCart.
async function settleCart(job, keep) {
  let why = '';
  for (let i = 0; i < 4; i++) {
    try {
      const done = await cleanCart(job);
      if (!keep.every((c) => done.codes.includes(c))) {
        return { gone: true, why: `the cart lists ${done.codes.join(', ') || 'no codes'}` };
      }
      if (done.people === job.have) {
        return { cart: { ok: true, checked: true, people: done.people, total: done.total } };
      }
      why = `${done.people} people in the cart`;
    } catch (e) {
      if (/the cart is empty/.test(errText(e))) return { gone: true, why: 'the cart is empty' };
      why = errText(e);
    }
    await sleep(1500 * (i + 1));
  }
  return { cart: { ok: true, checked: false }, why };
}

// A re-hold that kept its seats without a clean cart read looks again shortly after.
function recheckCart(job) {
  const client = job.client;
  setTimeout(async () => {
    if (job.state !== 'held' || job.client !== client || job.busy || job.paying) return;
    const s = await withCart(job, () => settleCart(job, job.codes)).catch(() => null);
    if (!s || job.state !== 'held' || job.client !== client) return;
    if (s.gone) {
      await deleteCodes({ client: job.client, csrf: job.csrf }, job.codes);
      lostHold(job, `the cart lost the re-held seats (${s.why})`);
      return;
    }
    job.cart = s.cart;
    log(`${s.cart.checked ? '✅' : '⚠️'} ${jobName(job)}: cart ${s.cart.checked ? `checked after the re-hold: ${s.cart.people} people, ${s.cart.total} €` : `still not readable (${s.why})`}`);
    saveState();
  }, 20e3);
}

// How many seats (up to max) the slot has free right now. The site lists a slot for a
// party of p only if p seats are free. Each question costs about a second.
async function seatsFree(job, max) {
  const listed = async (p) => {
    await acquire();
    try {
      const slots = await withScout((c, csrf) => getSlots(c, csrf, 'CL', job.date, p));
      return slots.some((s) => s.time === job.clSlot.time);
    } finally {
      release();
    }
  };
  if (max < 1 || !(await listed(1))) return 0;
  let lo = 1;
  let hi = max;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (await listed(mid)) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// While a hunt has nothing yet, the workers ask for everything at once. This looks every
// 15s for a smaller number of free seats and takes them as the first batch.
async function partialScout(job, gen, { max, firstDelay = PROBE_MS, partialOnly = false }) {
  const mine = () => job.gen === gen && job.state === 'hunting' && !S.stopping;
  let wait = firstDelay;
  while (mine()) {
    await sleep(wait);
    wait = PROBE_MS;
    if (!mine()) break;
    const k = await seatsFree(job, max).catch(() => 0);
    // partialOnly: if all the seats are still free the re-hold rush will get them.
    if (!k || (partialOnly && k >= max) || !mine()) continue;
    log(`🔎 ${jobName(job)}: ${k} seat(s) free right now — taking them`);
    let sess = null;
    try {
      sess = await newSession(k);
      await acquire();
      let r;
      const t0 = Date.now();
      try { r = await addToCart(sess, job.date, 'CL', job.clSlot, k); } finally { release(); }
      if (!r.codes.length) continue;
      if (!mine()) { await deleteCodes(sess, r.codes); continue; }
      job.state = 'securing';
      job.gen++;
      const won = sess;
      sess = null;
      await secure(job, won, r.codes, t0, k);
      return;
    } catch (e) {
      noteError(e);
    } finally {
      if (sess) sess.client.close();
    }
  }
}

function startTopUp(job) {
  if (job.topping || job.have >= job.qty || job.state !== 'held') return;
  job.topping = topUp(job)
    .catch((e) => log(`⚠️ stacking stopped: ${errText(e)}`))
    .finally(() => { job.topping = null; });
}

// Keeps adding batches to a cart that is not full yet. Mostly it asks for everything
// still missing; every 15s it checks whether a smaller number is free and takes that.
async function topUp(job) {
  const client = job.client;
  const sess = { client, csrf: job.csrf };
  const on = () => job.state === 'held' && job.client === client && !job.busy && !job.paying
    && !S.stopping && job.have < job.qty;
  let armed = 0;
  let baseline = null;
  // Right after a catch (and at the start) more seats may be free: count them once.
  let recount = true;
  log(`🧲 Stacking ${jobName(job)}: ${job.have}/${job.qty} held, hunting ${job.qty - job.have} more`);

  while (on()) {
    // Someone is at the checkout: keep the cart exactly as booked and wait.
    if (Date.now() - job.lastProxyAt < CHECKOUT_ACTIVE_MS) {
      if (armed || job.pending) {
        await withCart(job, () => cleanCart(job)).catch(() => {});
        armed = 0;
      }
      job.topLast = 'paused while the checkout is open';
      await sleep(2000);
      continue;
    }
    while (on() && othersRushing(job)) await sleep(50);
    const need = job.qty - job.have;
    // Seats come back one at a time far more often than six together, so the standing
    // shot asks for one: it lands the instant any seat is free.
    let want = 1;
    if (recount && need > 1) {
      const k = await seatsFree(job, need).catch(() => 0);
      if (k > 1) want = k;
    }
    recount = false;
    try {
      const got = await withCart(job, async () => {
        if (!on() || Date.now() - job.lastProxyAt < CHECKOUT_ACTIVE_MS) return 0;
        if (armed !== want) {
          await cleanCart(job);
          await setPax(sess, want);
          job.pending = want;
          armed = want;
          baseline = null;
        }
        await acquire();
        let r;
        try { r = await addToCart(sess, job.date, 'CL', job.clSlot, want); } finally { release(); }
        job.topTries++;
        if (!r.ok) throw new Error(r.why);
        job.topLast = 'full';
        if (r.text === baseline) return 0;
        const seen = await cartInfo(sess);
        const clNew = seen.codes.filter((c) => !job.codes.includes(c));
        if (!clNew.length) { baseline = r.text; return 0; }

        log(`🎉 Stacked ${want}× Colosseo ${job.clSlot.time} (${clNew.join(', ')}) — adding Carcere...`);
        const cms = [job.cmSlot, ...cmCandidates(job.cmSlots, job.clSlot).filter((s) => s.time !== job.cmSlot.time)];
        for (const cm of cms) {
          await addToCart(sess, job.date, 'CM', cm, want).catch(() => null);
          const after = await cartInfo(sess);
          const cmNew = after.codes.filter((c) => !job.codes.includes(c) && !clNew.includes(c));
          if (!cmNew.length) continue;
          job.codes = after.codes;
          job.have += want;
          job.batches++;
          job.pending = 0;
          job.cart = { ok: true, checked: true, people: after.people, total: after.total };
          armed = 0;
          return want;
        }
        // No Carcere time fits this batch: give the Colosseo seats back and go on.
        await deleteCodes(sess, clNew);
        armed = 0;
        return 0;
      });
      if (got) {
        recount = true;
        saveState();
        const done = job.have >= job.qty;
        log(`${done ? '✅' : '🟡'} ${jobName(job)}: now ${job.have}/${job.qty} in the cart (+${got})`);
        editJobMsgs(job, heldText(job), heldKb(job));
        tgNotify(done
          ? `✅ <b>All ${tickets(job.qty)} secured</b> — ${job.date} ${job.clSlot.time}\nPay now with 🛒 on the cart message.`
          : `🟡 <b>+${got} → ${job.have}/${job.qty} held</b> — ${job.date} ${job.clSlot.time}\nStill stacking the other ${job.qty - job.have}.`);
      } else if (GAP_MS) {
        await sleep(GAP_MS);
      }
    } catch (e) {
      job.topLast = `error: ${noteError(e)}`;
      armed = 0;
      await sleep(1500);
    }
  }
  // Leave the cart clean for the checkout, unless the session is already being replaced.
  if (job.client === client && job.state === 'held' && (armed || job.pending)) {
    await withCart(job, () => cleanCart(job)).catch(() => {});
  }
}

// ── Keeping a hold ─────────────────────────────────────
// The site drops a hold 15 minutes after it was made and nothing extends it (re-sending
// the request does not). The only way to keep the seats is to free them and catch them
// again with a new session, so every re-hold is a short window where someone else can win.
function scheduleKeepAlive(job, ms) {
  clearTimeout(job.timer);
  job.dueAt = Date.now() + ms;
  job.timer = setTimeout(() => keepAlive(job), ms);
}

async function keepAlive(job) {
  if (job.state !== 'held' || job.busy || job.paying || S.stopping) return;
  const age = Date.now() - job.heldAt;
  if (job.lastProxyAt && Date.now() - job.lastProxyAt < CHECKOUT_ACTIVE_MS && age < HOLD_TTL_MS - 90e3) {
    log(`⏸️ ${jobName(job)} is in checkout — re-hold postponed 30s`);
    scheduleKeepAlive(job, 30e3);
    return;
  }
  job.busy = true;
  let gated = false;
  try {
    // Let the stacking loop finish its step before the cart is touched.
    await job.topping;
    await job.chain;
    await reholdTurn(job);
    gated = true;
    if (job.state !== 'held' || job.paying || S.stopping) return;
    // Re-holds in one session get slower each round (15s grows to 90s within about ten
    // rounds, measured), so the cart moves to a fresh session before that matters.
    if (job.renewals >= MAX_QUICK_RENEWALS) {
      log(`🔁 ${jobName(job)}: ${job.renewals} quick re-holds on this session — moving to a fresh one`);
      await swapToFreshSessions(job);
      return;
    }
    job.rushUntil = Date.now() + 20e3;
    const res = await renewInPlace(job, { inPlace: !teamReady(job) });
    job.rushUntil = 0;
    if (res.noSpare) {
      await swapToFreshSessions(job);
      return;
    }
    if (res.how) {
      scheduleTeam(job);
      job.renewals++;
      job.quickRetries = 0;
      if (!job.cart?.checked) recheckCart(job);
      log(`♻️ Re-held ${job.have} of ${jobName(job)} ${res.how} in ${res.ms}ms (${res.steps}) — ${job.codes.join(', ')}`);
      saveState();
      scheduleKeepAlive(job, planRehold(job));
      editJobMsgs(job, heldText(job, `♻️ Re-held ${res.how}, timer reset`), heldKb(job));
      return;
    }
    if (!res.freed) {
      // Nothing was released: the old hold is intact. Trying the quick way again is far
      // safer than the fresh-session swap, which frees every seat and must win them back.
      const left = HOLD_TTL_MS - (Date.now() - job.heldAt);
      if ((job.quickRetries || 0) < QUICK_RETRIES && left > 75e3 && !/more than one batch/.test(errText(res.error))) {
        job.quickRetries = (job.quickRetries || 0) + 1;
        log(`⚠️ ${jobName(job)}: quick re-hold not possible (${errText(res.error)}) — nothing was released, trying again in 5s`);
        scheduleKeepAlive(job, 5000);
        return;
      }
      log(`⚠️ ${jobName(job)}: quick re-hold not possible (${errText(res.error)}) — using fresh sessions`);
      await swapToFreshSessions(job);
      return;
    }
    // The old seats were released and could not be booked again in this session.
    log(`⚠️ ${jobName(job)}: quick re-hold failed after the release (${errText(res.error)})`);
    lostHold(job, 'the seats could not be re-booked during the re-hold');
  } catch (e) {
    // Whatever went wrong, a held cart must never be left without its next re-hold.
    log(`⚠️ ${jobName(job)}: re-hold crashed (${errText(e)}) — trying again in 20s`);
    if (job.state === 'held') scheduleKeepAlive(job, 20e3);
  } finally {
    if (gated) reholdDone();
    job.rushUntil = 0;
    job.busy = false;
    if (job.state === 'held') startTopUp(job);
  }
}

// When the next re-hold should start: on time, or moved up to 3 minutes earlier so it
// starts at least REHOLD_SPACING_MS away from every other planned re-hold.
function planRehold(job) {
  const due = job.heldAt + KEEPALIVE_MS;
  const taken = heldJobs().filter((j) => j !== job && !j.paying && j.dueAt).map((j) => j.dueAt);
  const clash = (t) => taken.some((x) => Math.abs(x - t) < REHOLD_SPACING_MS);
  let t = due;
  while (clash(t) && t > due - 180e3) t -= 5e3;
  if (clash(t)) t = due;
  return Math.max(5000, t - Date.now());
}

const reholdGate = { running: 0, waiting: [] };
function reholdTurn(job) {
  if (reholdGate.running < MAX_REHOLDS) { reholdGate.running++; return Promise.resolve(); }
  return new Promise((r) => reholdGate.waiting.push({ job, r }));
}
// The hold closest to expiring goes next.
function reholdDone() {
  reholdGate.waiting.sort((a, b) => a.job.heldAt - b.job.heldAt);
  const next = reholdGate.waiting.shift();
  if (next) next.r(); else reholdGate.running--;
}

// Renews the hold inside the cart's own session, with no new sessions.
// 1. Leapfrog: announce the same number of people again and book that second batch
//    while the old one is still held, then release the old one. The seats are never
//    free. Needs as many spare seats on the slot as the cart holds.
// 2. In place: if there are no spare seats, release the old reservations and book the
//    waiting batch at once (the seats are free for well under a second).
// Returns { how, ms } on success, or { error, freed } where freed tells whether the old
// reservations were already released when it failed.
async function renewInPlace(job, { inPlace = true } = {}) {
  return withCart(job, async () => {
    const sess = { client: job.client, csrf: job.csrf };
    const n = job.have;
    const old = [...job.codes];
    const fresh = (info) => info.codes.filter((c) => !old.includes(c));
    const started = Date.now();
    let freed = false;
    let made = []; // codes the in-place path was handed by replies
    // Step timings for the log: where a slow re-hold spends its time.
    const marks = [];
    let last = started;
    const mark = (name) => { marks.push(`${name} ${Date.now() - last}ms`); last = Date.now(); };
    const steps = () => marks.join(', ');
    try {
      let before = await cleanCart(job);
      // Codes the bot did not book (a late reply, a half-finished earlier attempt) would
      // be mistaken for the new batch and wreck the re-hold, so they go first.
      const unknown = before ? before.codes.filter((c) => !old.includes(c)) : [];
      if (unknown.length) {
        log(`   ${jobName(job)}: the cart holds codes the bot did not book (${unknown.join(', ')}) — releasing them first`);
        await deleteCodes(sess, unknown);
        before = await cleanCart(job);
      }
      mark('check');
      if (!before || before.people !== n || !old.every((c) => before.codes.includes(c))
        || before.codes.some((c) => !old.includes(c))) {
        throw new Error(`the cart is not as expected (${before?.people} people, ${before?.codes.length} codes)`);
      }
      // One question to the site says whether the slot has n spare seats. Without them
      // the leapfrog cannot work, and trying it anyway costs five requests.
      const spare = await withScout((c, csrf) => getSlots(c, csrf, 'CL', job.date, n))
        .then((slots) => slots.some((x) => x.time === job.clSlot.time), () => false);
      mark('spare?');
      // No spare seats and a team is ready: the hand-over to the team is faster and
      // keeps several requests in flight, so nothing in this cart is touched.
      if (!spare && !inPlace) return { noSpare: true, freed: false };
      let bookedAt = Date.now();
      let info = before;
      if (spare) {
        await setPax(sess, n);
        job.pending = n;
        bookedAt = Date.now();
        await addToCart(sess, job.date, 'CL', job.clSlot, n).catch(() => null);
        info = await cartInfo(sess);
        mark('leapfrog shot');
      }
      let how = 'with no gap';
      if (!fresh(info).length) {
        // No spare seats. A pending line must go first: with two unbooked lines the
        // site hands out a code but empties the cart, and the seat is locked for nobody.
        if (job.pending) {
          const clean = await cleanCart(job);
          if (clean.people !== n || fresh(clean).length || !old.every((c) => clean.codes.includes(c))) {
            throw new Error('the pending line could not be removed cleanly');
          }
          mark('undo');
        }
        // Releasing a cart built from several batches leaves several unbooked lines,
        // the same trap, so that case is left to the fresh-session method.
        if (job.batches !== 1) throw new Error('no spare seats, and the cart has more than one batch');
        how = 'in place';
        freed = true;
        const releasedFrom = Date.now();
        await deleteCodes(sess, old);
        mark('release');
        // From here until both halves are booked again the cart page must NOT be read:
        // reading it while the cart has no finished ticket wipes the cart, and whatever
        // is booked afterwards gets a code but belongs to no cart. Only replies are used.
        const cms = [job.cmSlot, ...cmCandidates(job.cmSlots, job.clSlot).filter((s) => s.time !== job.cmSlot.time)];
        for (let i = 0; i < 12 && !made.length; i++) {
          bookedAt = Date.now();
          const r = await addToCart(sess, job.date, 'CL', job.clSlot, n).catch(() => null);
          made = (r?.codes || []).filter((c) => !old.includes(c));
          if (!made.length) await sleep(300);
        }
        if (!made.length) throw new Error('the seats were taken by someone else');
        // Upper bound on how long the seats were free: from sending the release to the
        // reply that confirmed the new booking.
        marks.push(`seats free at most ${Date.now() - releasedFrom}ms`);
        last = Date.now();
        let cmSlot = null;
        for (const cm of cms) {
          const r = await addToCart(sess, job.date, 'CM', cm, n).catch(() => null);
          const more = (r?.codes || []).filter((c) => !old.includes(c) && !made.includes(c));
          if (more.length) { made = [...made, ...more]; cmSlot = cm; break; }
        }
        if (!cmSlot) throw new Error('Carcere could not be re-booked');
        mark('carcere');
        const s = await settleCart(job, made);
        mark('verify');
        if (s.gone) throw new Error(`the new seats are not in the cart (${s.why})`);
        Object.assign(job, { codes: made, cmSlot, heldAt: bookedAt, pending: 0, batches: 1, cart: s.cart });
        return { how: s.cart.checked ? how : `${how}, cart check pending (${s.why})`, ms: Date.now() - started, steps: steps() };
      }
      const clNew = fresh(info);
      let cmSlot = null;
      const cms = [job.cmSlot, ...cmCandidates(job.cmSlots, job.clSlot).filter((s) => s.time !== job.cmSlot.time)];
      for (const cm of cms) {
        await addToCart(sess, job.date, 'CM', cm, n).catch(() => null);
        info = await cartInfo(sess);
        if (fresh(info).length > clNew.length) { cmSlot = cm; break; }
      }
      if (!cmSlot) throw new Error('no Carcere time could be booked for the new batch');
      const keep = fresh(info);
      mark('carcere');
      await deleteCodes(sess, old);
      freed = true;
      mark('release old');
      const s = await settleCart(job, keep);
      mark('verify');
      if (s.gone) {
        made = keep;
        throw new Error(`the new seats are not in the cart (${s.why})`);
      }
      Object.assign(job, { codes: keep, cmSlot, heldAt: bookedAt, pending: 0, batches: 1, cart: s.cart });
      return { how: s.cart.checked ? how : `${how}, cart check pending (${s.why})`, ms: Date.now() - started, steps: steps() };
    } catch (error) {
      log(`   re-hold steps before the failure: ${steps() || 'none'}`);
      // Leave nothing behind in this session that the bot does not know about: first
      // what the replies reported, then anything else the cart page still lists. After a
      // release this runs only once settleCart has proven the new seats are not in the
      // cart, so freeing them lets the hunt catch them again.
      if (made.length) await deleteCodes(sess, made).catch(() => {});
      try {
        const now = await cartInfo(sess);
        const stray = freed ? now.codes : now.codes.filter((c) => !old.includes(c));
        if (stray.length) await deleteCodes(sess, stray);
        if (!freed) await cleanCart(job);
      } catch {}
      return { error, freed };
    }
  });
}

// Opens the new sessions first (one at a time: parallel opens slow the site), then
// frees the seats and fires the rush at them. While the rush lasts, every other hunt
// holds its fire, so our own requests are not in the way.
async function swapToFreshSessions(job) {
  // Let the stacking loop finish its step, so nothing lands in the old cart afterwards.
  await job.topping;
  await job.chain;
  const usable = () => job.state === 'held' && !job.paying && !S.stopping;
  const left = () => HOLD_TTL_MS - (Date.now() - job.heldAt);
  // The prepared team, fastest first. Only if it is missing or too small are sessions
  // opened now, and that is cut off 45s before the hold expires.
  const warm = job.team.filter((x) => x.qty === job.have);
  job.team.filter((x) => x.qty !== job.have).forEach((x) => x.client.close());
  job.team = [];
  clearTimeout(job.teamTimer);
  log(`🔄 Re-holding ${job.have} of ${jobName(job)}: ${warm.length ? `handing over to ${warm.length} prepared shooters` : `preparing ${RUSH_SHOTS} sessions`}...`);
  for (let i = warm.length; i < (warm.length >= 2 ? 0 : RUSH_SHOTS) && usable() && left() > 45e3; i++) {
    const opening = newSession(job.have).catch((e) => { noteError(e); return null; });
    const sess = await Promise.race([opening, sleep(left() - 45e3).then(() => undefined)]);
    if (sess === undefined) opening.then((late) => late?.client.close());
    else if (sess) warm.push(sess);
    else await sleep(1000);
  }
  if (!usable()) { warm.forEach((s) => s.client.close()); return; }
  const old = { client: job.client, csrf: job.csrf };
  const oldCodes = job.codes;
  job.client = null;
  job.codes = [];
  job.huntReason = 'swap';
  job.swapAt = Date.now();
  job.swapFulls = 0;
  job.swapHave = job.have;
  // The rush window proper starts when the site confirms the release.
  job.rushUntil = Date.now() + 30e3;
  const freeing = releaseFast(old, oldCodes);
  hunt(job, warm, freeing);
  await freeing;
  if (rushing(job)) job.rushUntil = Date.now() + RUSH_MS;
  old.client.close();
}

function lostHold(job, why) {
  if (job.state !== 'held') return;
  log(`⚠️ Lost ${jobName(job)} (${why}) — hammering again`);
  if (job.client) job.client.close();
  job.client = null;
  job.codes = [];
  job.have = 0;
  job.pending = 0;
  job.huntReason = 'lost';
  tgNotify(`⚠️ <b>Lost ${jobName(job)}</b>\n${esc(why)}\n🎯 Hammering the slot again...`);
  hunt(job);
}

// Only a 302 (empty cart) proves a hold is gone; network errors are not evidence.
async function checkHeldJobs() {
  for (const job of heldJobs()) {
    if (job.busy) continue;
    const client = job.client;
    let r;
    try { r = await client.http('GET', CHECKOUT_URL); } catch { continue; }
    if (!cartIsEmpty(r) || job.state !== 'held' || job.client !== client || job.busy) continue;
    if (job.paying) {
      await stopJob(job, {
        keep: true,
        head: '🧾 <b>Cart closed after payment started</b> — job finished\nIf the payment did not go through, start a new hunt.',
      });
    } else {
      lostHold(job, 'the site emptied the cart');
    }
  }
}

// `keep` leaves the reservations alone (they belong to an order now).
async function stopJob(job, { keep = false, head } = {}) {
  if (job.state === 'done') return;
  const wasHeld = job.state === 'held';
  job.state = 'done';
  job.gen++;
  clearTimeout(job.timer);
  clearTimeout(job.catchupTimer);
  dropTeam(job);
  S.jobs = S.jobs.filter((j) => j !== job);
  saveState();
  await job.topping;
  await job.chain;
  if (wasHeld && !keep) await deleteCodes({ client: job.client, csrf: job.csrf }, job.codes);
  if (job.client) job.client.close();
  const title = head || (wasHeld ? '❌ <b>Released</b>' : '⏹ <b>Hunt stopped</b>');
  log(`${title.replace(/<[^>]+>/g, '').split('\n')[0]} — ${jobName(job)}`);
  editJobMsgs(job, `${title}\n📅 ${job.date}\n🏛️ ${job.clSlot.time} · ${tickets(wasHeld ? job.have : job.qty)}`);
}

// Once the pay form has been accepted the cart must not be touched, so re-holding stays
// off until the user says how it went. (job.paying is set when the form is submitted.)
function resumeReholds(job) {
  if (job.state !== 'held' || !job.paying) return;
  job.paying = 0;
  scheduleKeepAlive(job, planRehold(job));
  saveState();
  startTopUp(job);
}

function announcePayStarted(job) {
  if (job.state !== 'held') return;
  saveState();
  const left = fmtDur(Math.max(0, HOLD_TTL_MS - (Date.now() - job.heldAt)));
  log(`💳 Payment started for ${jobName(job)} — re-holding paused`);
  tgNotify(
    `💳 <b>Payment started</b> — ${jobName(job)}\nRe-holding is paused so the cart is not touched.\n` +
    `⏱ The hold has about ${left} left: finish the payment before then.`,
    payKb(job),
  );
}

const payKb = (job) => ({ inline_keyboard: [
  [{ text: '✅ I paid', callback_data: `paid_${job.id}` }],
  [{ text: '▶️ Not paid — resume re-holding', callback_data: `resume_${job.id}` }],
] });

// ── Job messages ───────────────────────────────────────
function fmtDur(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function ttlStr(job) {
  return fmtDur(Math.max(0, HOLD_TTL_MS - (Date.now() - job.heldAt)));
}

function huntText(job) {
  const title = job.huntReason === 'swap' ? '♻️ <b>Re-holding' : '🎯 <b>Hunting';
  const last = job.lastResult === 'full' ? '❌ full' : esc(job.lastResult);
  const captured = job.state === 'securing'
    ? `🎟️ Colosseo ${job.qty}/${job.qty} ✅ · Carcere ⏳ adding...`
    : `🎟️ Captured: 0/${job.qty}`;
  return `${title} ${tickets(job.huntReason === 'swap' ? job.have : job.qty)}</b>\n📅 ${job.date}\n🏛️ ${job.clSlot.time}\n\n` +
    `${captured}\n` +
    `🔁 ${job.attempts.toLocaleString('en')} tries · ⏱️ ${fmtDur(Date.now() - job.startedAt)}\n` +
    `Last: ${last}${job.lastMs ? ` (${job.lastMs}ms)` : ''}`;
}

function heldText(job, note) {
  const c = job.cart;
  const full = job.have >= job.qty;
  const cart = !c?.checked ? '⚠️ Cart page could not be read to double-check — open it to confirm\n'
    : c.people === job.have ? `🧾 Cart checked on the site: ${tickets(c.people)}${c.total ? ` · ${c.total} €` : ''}\n`
      : `⚠️ Cart shows ${c.people} people, expected ${job.have}\n`;
  const last = job.topLast === 'full' ? '❌ full' : esc(job.topLast);
  const stacking = full ? ''
    : `🧲 Stacking the other ${job.qty - job.have}: ${job.topTries.toLocaleString('en')} tries · last ${last}\n`;
  return `${full ? `✅ <b>${tickets(job.qty)} secured!</b>` : `🟡 <b>${job.have} of ${job.qty} tickets held</b> — collecting the rest`}\n\n` +
    `📅 ${job.date}\n🏛️ ${job.clSlot.time}\n` +
    `🎟️ Captured: ${job.have}/${job.qty} in one cart\n${stacking}${cart}` +
    `🔑 ${job.codes.join(', ')}\n` +
    `⏱ Pay soon: every ${Math.round(KEEPALIVE_MS / 60e3)} min the bot has to free and re-catch the seats` +
    `${note ? `\n${note}` : ''}`;
}

const stopKb = (job) => ({ inline_keyboard: [[{ text: '⏹ Stop hunting', callback_data: `stop_${job.id}` }]] });
const heldKb = (job) => ({ inline_keyboard: [
  [{ text: job.have < job.qty ? `🛒 Checkout (${job.have} now)` : '🛒 Checkout', callback_data: `co_${job.id}` }, { text: '❌ Release', callback_data: `rel_${job.id}` }],
  [{ text: '💳 I paid — stop re-holding', callback_data: `paid_${job.id}` }],
  ...(job.have < job.qty ? [[{ text: `🏁 Stop at ${job.have} and check out`, callback_data: `fin_${job.id}` }]] : []),
] });

// Edits the job's messages in place; without kb the buttons are removed.
// Progress edits pass sure=false so they are simply skipped when Telegram is rate-limiting.
function editJobMsgs(job, text, kb, sure = true) {
  for (const { chatId, msgId } of job.msgs) {
    const body = { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', text, ...(kb ? { reply_markup: kb } : {}) };
    if (sure) tgSure('editMessageText', body);
    else tgSend('editMessageText', body).catch(() => {});
  }
}

// tmux gets a line per hunt every 2s. Telegram edits are slower, and slower still with
// several hunts, to stay under Telegram's per-chat limit.
let tick = 0;
function statusTicker() {
  tick++;
  const hunting = huntingJobs();
  const every = Math.max(5, 3 * hunting.length);
  for (const job of hunting) {
    const rate = (job.attempts - job.prevAttempts) / 2;
    job.prevAttempts = job.attempts;
    const last = job.lastResult === 'full' ? '❌ full' : job.lastResult;
    log(`🎯 ${jobName(job)} | ${job.attempts.toLocaleString('en')} tries | ${rate.toFixed(1)}/s | last ${last}${job.lastMs ? ` ${job.lastMs}ms` : ''}`);

    if (job.bad >= 30 && !job.badWarned) {
      job.badWarned = true;
      tgNotify(`⚠️ <b>${jobName(job)}</b>: the site is not answering normally (${esc(job.lastResult)}).\nStill retrying with new sessions.`);
    }
    if (!job.bad) job.badWarned = false;

    if (job.huntReason === 'swap') {
      // A re-hold normally takes a second or two. The seats only count as taken by
      // someone else once the site has answered "full" several times well after the
      // release; a slow site alone proves nothing.
      if (job.state !== 'hunting' || Date.now() - job.swapAt < 20e3 || job.swapFulls < 8) continue;
      job.huntReason = 'lost';
      log(`⚠️ ${jobName(job)}: seats were taken during the re-hold — hammering to get them back`);
      tgNotify(`⚠️ <b>${jobName(job)}</b>: someone took the seats during the re-hold.\n🎯 Hammering to get them back...`);
      // Back to a full hunt: take any number of seats again, up to the whole order.
      if (job.state === 'hunting') { job.have = 0; hunt(job); scheduleCatchup(job, job.swapAt); }
      continue;
    }
    if ((tick + job.id) % every === 0) {
      const text = huntText(job);
      if (text !== job.lastTgText) {
        job.lastTgText = text;
        editJobMsgs(job, text, stopKb(job), false);
      }
    }
  }
  // Carts that are still being filled: same rhythm, on the cart message.
  for (const job of heldJobs().filter((j) => j.topping)) {
    const last = job.topLast === 'full' ? '❌ full' : job.topLast;
    log(`🧲 ${jobName(job)} | ${job.have}/${job.qty} held | ${job.topTries.toLocaleString('en')} tries for the rest | last ${last}`);
    if ((tick + job.id) % every === 0) {
      const text = heldText(job);
      if (text !== job.lastTgText) {
        job.lastTgText = text;
        editJobMsgs(job, text, heldKb(job), false);
      }
    }
  }
}

// Every minute: ends jobs whose time has passed, re-reads slot ids so a hunt never
// hammers a dead id, and checks that held carts still exist.
let maintaining = false;
async function maintain() {
  if (maintaining || S.stopping) return;
  maintaining = true;
  try {
    for (const job of liveJobs()) {
      if (isPast(job.date, job.clSlot.time)) {
        await stopJob(job, { keep: !!job.paying, head: '⌛ <b>Slot time has passed</b> — job ended' });
      }
    }
    for (const date of new Set(huntingJobs().map((j) => j.date))) {
      let day;
      try { day = await fetchSlots(date); } catch { continue; }
      for (const job of huntingJobs().filter((j) => j.date === date)) {
        const cl = day.cl.find((s) => s.time === job.clSlot.time);
        if (cl && cl.id !== job.clSlot.id) {
          log(`ℹ️ ${jobName(job)}: the site changed the slot id — following it`);
          job.clSlot = cl;
        }
        if (!cl && day.cl.length && !job.goneWarned) {
          job.goneWarned = true;
          tgNotify(`⚠️ <b>${jobName(job)}</b>: the site no longer lists this time. Still hammering it; stop the hunt if it was removed.`);
        }
        if (day.cm.length) job.cmSlots = day.cm;
      }
    }
    await checkHeldJobs();
  } finally {
    maintaining = false;
  }
}

// ── Checkout proxy server ──────────────────────────────
let proxyHost = '';

function checkoutLink(job) {
  const scheme = proxyHost.includes('trycloudflare.com') ? 'https' : 'http';
  return `${scheme}://${proxyHost}/${job.token}`;
}

function startCheckoutProxy() {
  const server = http.createServer((req, res) => {
    const m = req.url.match(/^\/([A-Za-z0-9_-]{12})(\/.*)?$/);
    if (!m) { res.writeHead(404); res.end('Not found'); return; }

    const job = S.jobs.find((j) => j.token === m[1] && j.state !== 'done');
    if (!job) {
      res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>This cart was released or paid</h2><p>Check Telegram for the current jobs.</p>');
      return;
    }
    if (job.state !== 'held') {
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '3' });
      res.end('<meta http-equiv="refresh" content="3"><h2>The bot is re-catching these tickets…</h2><p>This page reloads by itself. Check Telegram for the status.</p>');
      return;
    }
    job.lastProxyAt = Date.now();

    const client = job.client;
    const sitePath = m[2] || `/${LOC}/vouchers/checkout`;
    const cookieStr = Object.entries(client.jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const base = checkoutLink(job);
    // Re-holding stops the instant the pay form is submitted, before the site answers.
    const payPost = req.method === 'POST' && /\/vouchers\/pay(\?|\/|$)/.test(sitePath) && !job.paying;
    if (payPost) { job.paying = Date.now(); clearTimeout(job.timer); }

    const body = [];
    req.on('data', (c) => body.push(c));
    req.on('end', async () => {
      // While the bot is stacking, the cart may carry people it announced but has not
      // booked. They are removed before the page is fetched, so the total is always real.
      // A re-hold in progress is waited for the same way.
      await job.chain;
      if (job.pending || (job.have < job.qty && job.topping)) {
        await withCart(job, () => cleanCart(job)).catch(() => {});
        if (job.client !== client) {
          res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<meta http-equiv="refresh" content="3"><h2>The bot is re-catching these tickets…</h2>');
          return;
        }
      }
      const bodyBuf = Buffer.concat(body);
      const opts = {
        hostname: 'www.omniavaticanrome.org',
        port: 443,
        path: sitePath,
        method: req.method,
        headers: {
          'Host': 'www.omniavaticanrome.org',
          'Cookie': cookieStr,
          'User-Agent': UA,
          'Accept': req.headers.accept || '*/*',
          'Accept-Language': 'it-IT,it;q=0.9',
          'Accept-Encoding': 'identity',
          'Referer': `https://www.omniavaticanrome.org${sitePath}`,
        },
      };
      if (req.headers['content-type']) opts.headers['Content-Type'] = req.headers['content-type'];
      if (bodyBuf.length) opts.headers['Content-Length'] = bodyBuf.length;
      if (req.headers['x-csrf-token']) opts.headers['X-CSRF-Token'] = req.headers['x-csrf-token'];
      if (req.headers['x-requested-with']) opts.headers['X-Requested-With'] = req.headers['x-requested-with'];

      const proxyReq = https.request(opts, (proxyRes) => {
        const chunks = [];
        proxyRes.on('data', (d) => chunks.push(d));
        // The reply was cut off mid-way: nothing is known, so treat the pay as not started.
        proxyRes.on('aborted', () => {
          if (payPost) resumeReholds(job);
          res.destroy();
        });
        proxyRes.on('end', () => {
          let result = Buffer.concat(chunks);
          const ct = proxyRes.headers['content-type'] || '';

          if (payPost) {
            // Sent straight back to the checkout page, or an error page (a page opened
            // before a re-hold fails this way) = the form was rejected, nothing started.
            const back = /\/vouchers\/checkout\/?$/.test(proxyRes.headers.location || '');
            if (back || proxyRes.statusCode >= 400) {
              log(`ℹ️ ${jobName(job)}: pay form was not accepted (${back ? 'sent back to the form' : `HTTP ${proxyRes.statusCode}`})`);
              resumeReholds(job);
              if (!back) tgNotify(`⚠️ <b>${jobName(job)}</b>: the site rejected the pay form (HTTP ${proxyRes.statusCode}).\nOpen the cart again with 🛒 and retry; the tickets are still held.`);
            } else {
              announcePayStarted(job);
            }
          }

          // The bot owns the session, so cookie updates go into its jar, unless a
          // re-hold replaced the session while this request was in flight.
          if (job.client === client) {
            for (const c of [].concat(proxyRes.headers['set-cookie'] || [])) {
              const [kv] = c.split(';');
              const i = kv.indexOf('=');
              if (i > 0) client.jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
            }
          }

          if (ct.includes('text/html')) {
            let html = result.toString();
            html = html.replace(/https:\/\/www\.omniavaticanrome\.org/g, base);
            html = html.replace(/(href|src|action)="\/(?!\/)([^"]*?)"/g, `$1="/${job.token}/$2"`);
            result = Buffer.from(html);
          }

          const fwd = {};
          for (const [k, v] of Object.entries(proxyRes.headers)) {
            if (['content-security-policy', 'strict-transport-security', 'x-frame-options', 'content-length',
              'content-encoding', 'transfer-encoding', 'set-cookie'].includes(k)) continue;
            fwd[k] = v;
          }
          if (fwd.location) {
            fwd.location = fwd.location.replace('https://www.omniavaticanrome.org', base);
            if (fwd.location.startsWith('/')) fwd.location = `/${job.token}${fwd.location}`;
          }
          fwd['content-length'] = result.length;

          res.writeHead(proxyRes.statusCode, fwd);
          res.end(result);
        });
      });

      proxyReq.setTimeout(60000, () => proxyReq.destroy(new Error('the site did not answer in 60s')));
      proxyReq.on('error', (e) => {
        if (payPost) resumeReholds(job);
        if (res.headersSent) { res.end(); return; }
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`The ticket site did not answer (${e.message}). Reload the page.`);
      });
      if (bodyBuf.length) proxyReq.write(bodyBuf);
      proxyReq.end();
    });
  });

  server.listen(PROXY_PORT, '127.0.0.1', () => {
    log(`Checkout proxy on 127.0.0.1:${PROXY_PORT}`);
  });
}

// Checkout links go through a cloudflared quick tunnel. Its address is taken whenever
// cloudflared prints one, and the tunnel is started again if it dies.
let tunnelChild = null;
process.on('exit', () => tunnelChild?.kill());

// Local control port, so jobs can be started by a script on this server exactly as if
// they were tapped in Telegram. It listens on 127.0.0.1 only and is not behind the tunnel.
function startAdmin() {
  const port = Number(process.env.ADMIN_PORT || 4101);
  http.createServer(async (req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      const u = new URL(req.url, 'http://local');
      const q = (k) => u.searchParams.get(k) || '';
      if (u.pathname === '/jobs') {
        return send(200, liveJobs().map((j) => ({
          id: j.id, date: j.date, time: j.clSlot.time, qty: j.qty, have: j.have, state: j.state, tries: j.attempts,
        })));
      }
      if (req.method !== 'POST') return send(404, { error: 'not found' });
      if (u.pathname === '/hunt') {
        const date = q('date');
        const time = q('time');
        const qty = Number(q('qty') || MAX_QTY);
        if (!/^\d{4}-\d\d-\d\d$/.test(date) || !/^\d\d:\d\d$/.test(time) || !(qty >= 1 && qty <= MAX_QTY)) {
          return send(400, { error: 'expected date=YYYY-MM-DD, time=HH:MM, qty=1-7' });
        }
        if (liveJobs().some((j) => j.date === date && j.clSlot.time === time)) {
          return send(409, { error: 'a job for this slot already exists' });
        }
        const { slot } = await findSlot(date, time);
        if (!slot) return send(404, { error: 'the site does not list this time' });
        const job = await startJob(date, slot, qty);
        return send(200, { id: job.id });
      }
      if (u.pathname === '/stop') {
        const job = S.jobs.find((j) => j.id === Number(q('id')) && j.state !== 'done');
        if (!job) return send(404, { error: 'no such job' });
        await stopJob(job);
        return send(200, { stopped: job.id });
      }
      send(404, { error: 'not found' });
    } catch (e) {
      send(500, { error: errText(e) });
    }
  }).listen(port, '127.0.0.1', () => log(`Admin port on 127.0.0.1:${port}`));
}

function startTunnel() {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    proxyHost = proxyHost || `localhost:${PROXY_PORT}`;
    const child = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${PROXY_PORT}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    tunnelChild = child;

    const parse = (data) => {
      const m = data.toString().match(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)/);
      if (!m || proxyHost === m[1]) return;
      proxyHost = m[1];
      log(`Tunnel: https://${m[1]}`);
      resolve();
    };
    child.stdout.on('data', parse);
    child.stderr.on('data', parse);

    let ended = false;
    const down = (why) => {
      if (ended || S.stopping) return;
      ended = true;
      proxyHost = `localhost:${PROXY_PORT}`;
      log(`⚠️ Tunnel down (${why}) — restarting it in 5s`);
      if (heldJobs().length) tgNotify('⚠️ The checkout link address is changing. Tap 🛒 again in a few seconds for a new link.');
      setTimeout(() => startTunnel(), 5000);
      resolve();
    };
    child.on('error', (e) => down(e.message));
    child.on('exit', (code) => down(`cloudflared exited ${code}`));

    setTimeout(() => {
      if (proxyHost.startsWith('localhost')) log('Tunnel not ready after 15s — checkout links wait for it');
      resolve();
    }, 15000);
  });
}

// ── Markers shared by CLI and Telegram ─────────────────
function dayMarks(date) {
  const jobs = liveJobs().filter((j) => j.date === date);
  const held = jobs.filter((j) => j.state === 'held').length;
  const hunting = jobs.length - held;
  return `${S.calendarAt && !S.excluded.has(date) ? ' 🟢' : ''}${hunting ? ` 🎯${hunting}` : ''}${held ? ` ✅${held}` : ''}`;
}

function slotMarks(date, clSlot, cmSlots) {
  if (isPast(date, clSlot.time)) return ' ⌛';
  if (!cmCandidates(cmSlots, clSlot).length) return ' ⛔';
  const jobs = liveJobs().filter((j) => j.date === date && j.clSlot.time === clSlot.time);
  const held = jobs.filter((j) => j.state === 'held').length;
  const hunting = jobs.length - held;
  return `${hunting ? ' 🎯' : ''}${held ? ' ✅' : ''}`;
}

// What the 🛒 button says about timing: the checkout page only stays valid until the next re-hold.
function checkoutTiming(job) {
  if (job.paying) return '⏸ Payment started — re-holding is paused';
  const toRehold = Math.max(0, job.heldAt + KEEPALIVE_MS - Date.now());
  return toRehold < 4 * 60e3
    ? `⚠️ Next re-hold in ${fmtDur(toRehold)}. Better wait for it, then pay with a fresh ${Math.round(KEEPALIVE_MS / 60e3)} min.`
    : `⏱ ${fmtDur(toRehold)} before the next re-hold — enough to pay now.`;
}

// ── CLI Menu ───────────────────────────────────────────
async function cliMain() {
  for (;;) {
    console.log('\n=== OMNIA SNIPER ===');
    console.log(`Proxy: ${PROXY ? 'evomi' : 'direct'} | ${WORKERS} requests at a time | Hunting: ${huntingJobs().length} | Held: ${heldJobs().length}\n`);
    console.log('[1] Dates (all days)');
    console.log(`[2] Jobs (${liveJobs().length})`);
    console.log('[3] Refresh calendar');
    console.log('[0] Exit (jobs resume on next start)\n');

    const c = (await ask('> ')).trim();
    try {
      if (c === '1') await cliDates();
      else if (c === '2') await cliJobs();
      else if (c === '3') await refreshCalendar();
      else if (c === '0') await cleanup();
    } catch (e) {
      log(`⚠️ ${errText(e)}`);
    }
  }
}

async function cliDates() {
  if (!S.calendarAt) await refreshCalendar().catch((e) => log(`⚠️ Calendar: ${errText(e)}`));
  for (;;) {
    const days = upcomingDays();
    console.log('\nDays (🟢 = the site shows availability; the others are sold out or closed, still huntable):');
    days.forEach((d, i) => console.log(`  [${i + 1}] ${d}${dayMarks(d)}`));
    console.log('  [0] Back\n');
    const c = (await ask('> ')).trim();
    if (c === '0') return;
    const d = days[parseInt(c) - 1];
    if (d) await cliSlots(d);
  }
}

async function cliSlots(date) {
  log(`Loading slots for ${date}...`);
  const day = await fetchSlots(date, true);
  if (!day.cl.length) { log('No time slots on this day (closed)'); return; }
  for (;;) {
    console.log(`\n${date} — Colosseo times (⛔ = no Carcere time ${CM_GAP_MIN}+ min before, ⌛ = passed):`);
    day.cl.forEach((s, i) => console.log(`  [${i + 1}] ${openMark(day, s)}${s.time}${slotMarks(date, s, day.cm)}`));
    console.log('  [0] Back\n');
    const c = (await ask('> ')).trim();
    if (c === '0') return;
    const slot = day.cl[parseInt(c) - 1];
    if (!slot) continue;
    const q = (await ask(`Tickets (1-${MAX_QTY}) [${MAX_QTY}]: `)).trim();
    const qty = q ? parseInt(q) : MAX_QTY;
    if (!(qty >= 1 && qty <= MAX_QTY)) { log('Invalid number'); continue; }
    await startJob(date, slot, qty);
  }
}

async function cliJobs() {
  for (;;) {
    const jobs = liveJobs();
    if (!jobs.length) { log('No jobs'); return; }
    console.log(`\nJobs (${jobs.length}):`);
    jobs.forEach((j, i) => {
      const st = j.state === 'held'
        ? `${j.have < j.qty ? '🟡' : '✅'} ${j.have}/${j.qty} held, ${ttlStr(j)} left${j.paying ? ', payment started' : ''} — ${checkoutLink(j)}`
        : `🎯 hunting, ${j.attempts.toLocaleString('en')} tries`;
      console.log(`  [${i + 1}] ${jobName(j)} | ${st}`);
    });
    console.log('\n  Type # to stop/release, p<#> = paid, [0] Back\n');
    const c = (await ask('> ')).trim();
    if (c === '0') return;
    const paid = c.startsWith('p');
    const j = jobs[parseInt(paid ? c.slice(1) : c) - 1];
    if (!j) continue;
    if (paid) await stopJob(j, { keep: true, head: '💳 <b>Paid</b> — re-holding stopped' });
    else await stopJob(j);
  }
}

// ── Telegram Menu ──────────────────────────────────────
const PER_PAGE = 15;

function mainMenuText() {
  return `🎯 <b>Omnia Sniper</b>\n🎯 ${huntingJobs().length} hunting · ✅ ${heldJobs().length} held`;
}

function mainMenuKb() {
  return { inline_keyboard: [
    [{ text: '📅 Dates', callback_data: 'dates_0' }, { text: `🎯 Jobs (${liveJobs().length})`, callback_data: 'jobs' }],
    [{ text: '🔄 Refresh calendar', callback_data: 'ref' }],
  ] };
}

function datesKb(page) {
  const days = upcomingDays();
  const start = page * PER_PAGE;
  const slice = days.slice(start, start + PER_PAGE);
  const rows = [];
  for (let i = 0; i < slice.length; i += 3) {
    rows.push(slice.slice(i, i + 3).map((d) => ({ text: d.slice(5) + dayMarks(d), callback_data: `d_${d}` })));
  }
  const nav = [];
  if (page > 0) nav.push({ text: '◀', callback_data: `dates_${page - 1}` });
  if (start + PER_PAGE < days.length) nav.push({ text: '▶', callback_data: `dates_${page + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: '🔙 Menu', callback_data: 'menu' }]);
  return { inline_keyboard: rows };
}

const datesPage = (date) => Math.max(0, Math.floor(upcomingDays().indexOf(date) / PER_PAGE));
const backKb = (data, text = '🔙 Back') => ({ inline_keyboard: [[{ text, callback_data: data }]] });

function slotsKb(date, day) {
  const rows = [];
  for (let i = 0; i < day.cl.length; i += 3) {
    rows.push(day.cl.slice(i, i + 3).map((s) => ({
      text: `${openMark(day, s)}${s.time}${slotMarks(date, s, day.cm)}`, callback_data: `s_${date}_${s.time}`,
    })));
  }
  rows.push([{ text: '🔙 Dates', callback_data: `dates_${datesPage(date)}` }]);
  return { inline_keyboard: rows };
}

function qtyKb(date, time) {
  const btn = (n) => ({ text: n === MAX_QTY ? `${n} ⭐` : `${n}`, callback_data: `q_${date}_${time}_${n}` });
  return { inline_keyboard: [
    [1, 2, 3, 4].map(btn),
    [5, 6, 7].map(btn),
    [{ text: '🔙 Back', callback_data: `d_${date}` }],
  ] };
}

const jobsText = () => '🎯 <b>Jobs</b>\n🎯 hunting · ✅ held';

function jobsKb() {
  const rows = liveJobs().map((j) => (j.state === 'held'
    ? [
      { text: `${j.have < j.qty ? '🟡' : '✅'} ${j.date.slice(5)} ${j.clSlot.time} ${j.have}/${j.qty} · ${ttlStr(j)}`, callback_data: 'noop' },
      { text: '🛒', callback_data: `co_${j.id}` },
      { text: '❌', callback_data: `rel_${j.id}` },
    ]
    : [
      { text: `🎯 ${j.date.slice(5)} ${j.clSlot.time} ×${j.qty} · ${j.attempts.toLocaleString('en')} tries`, callback_data: 'noop' },
      { text: '⏹', callback_data: `stop_${j.id}` },
    ]));
  if (!rows.length) rows.push([{ text: 'No jobs', callback_data: 'noop' }]);
  rows.push([{ text: '🔄 Refresh', callback_data: 'jobs' }]);
  rows.push([{ text: '🔙 Menu', callback_data: 'menu' }]);
  return { inline_keyboard: rows };
}

async function tgEdit(chatId, text, kb) {
  const prev = S.menuMsgs[chatId];
  if (prev) {
    const r = await tgSend('editMessageText', {
      chat_id: chatId, message_id: prev, text, reply_markup: kb, parse_mode: 'HTML',
    }).catch(() => null);
    if (!r || !r.ok) {
      const notModified = r?.description?.includes('not modified');
      if (!notModified) {
        const r2 = await tgSend('sendMessage', { chat_id: chatId, text, reply_markup: kb, parse_mode: 'HTML' });
        S.menuMsgs[chatId] = r2.result?.message_id;
      }
    }
  } else {
    const r = await tgSend('sendMessage', { chat_id: chatId, text, reply_markup: kb, parse_mode: 'HTML' });
    S.menuMsgs[chatId] = r.result?.message_id;
  }
}

// A chat is trusted once the owner (TELEGRAM_CHAT_ID) has used the bot in it.
function authorized(chatId, fromId) {
  if (S.chats.has(chatId)) return true;
  if (S.owner && fromId === S.owner) {
    S.chats.add(chatId);
    saveState();
    log(`Authorized chat ${chatId}`);
    return true;
  }
  return false;
}

// The slot list comes from the site each time, so buttons in old messages keep working.
async function findSlot(date, time) {
  const day = await fetchSlots(date);
  return { day, slot: day.cl.find((s) => s.time === time) };
}

async function showDates(chatId, page) {
  if (Date.now() - S.calendarAt > CALENDAR_MAX_MS) {
    await tgEdit(chatId, '⏳ Loading calendar...', { inline_keyboard: [] });
    await refreshCalendar().catch((e) => log(`⚠️ Calendar: ${errText(e)}`));
  }
  await tgEdit(chatId,
    `📅 <b>All days</b> (next ${SCAN_DAYS})\n🟢 the site shows availability · no mark = sold out or closed, still huntable`,
    datesKb(page));
}

async function showDay(chatId, date) {
  await tgEdit(chatId, `⏳ Loading ${date}...`, { inline_keyboard: [] });
  let day;
  try { day = await fetchSlots(date, true); } catch (e) {
    await tgEdit(chatId, `⚠️ Could not load ${date}: ${esc(noteError(e))}`, backKb(`dates_${datesPage(date)}`, '🔙 Dates'));
    return;
  }
  if (!day.cl.length) {
    await tgEdit(chatId, `📅 ${date} — closed, the site has no time slots for it`, backKb(`dates_${datesPage(date)}`, '🔙 Dates'));
    return;
  }
  await tgEdit(chatId,
    `📅 <b>${date}</b>${S.excluded.has(date) ? ' — sold out or closed on the site' : ''}\n` +
    `All ${day.cl.length} Colosseo times. Tap one to hunt it.\n🟢 has a free seat right now · ⛔ no Carcere time ${CM_GAP_MIN}+ min before · ⌛ passed`,
    slotsKb(date, day));
}

// Buttons on job messages and in the jobs list.
async function jobAction(act, job, chatId, msgId, fromMenu) {
  const ownMsg = job.msgs.some((x) => x.chatId === chatId && x.msgId === msgId);
  const dropButtons = () => {
    if (fromMenu || ownMsg) return;
    tgSend('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  };
  if (act === 'co') {
    const text = job.state !== 'held' ? '♻️ The bot is re-catching these tickets right now. Try again in a few seconds.'
      : proxyHost.startsWith('localhost') ? '⏳ The checkout link is not ready yet. Try again in a few seconds.'
        : `🛒 <b>Checkout</b>\n📅 ${job.date} | ${job.clSlot.time} · ${tickets(job.have)}${job.have < job.qty ? ` of ${job.qty} so far` : ''}\n${checkoutTiming(job)}\n\n👉 <a href="${checkoutLink(job)}">Open Cart</a>`;
    // No preview: Telegram would fetch the private cart link to build one.
    await tgSend('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text, link_preview_options: { is_disabled: true } });
    return;
  }
  const setButtons = (kb) => tgSend('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: kb }).catch(() => {});
  if ((act === 'rel' || act === 'paid') && job.state === 'held') {
    // One stray tap must not cost a caught cart, so both of these ask first.
    const yes = act === 'rel'
      ? { text: `✅ Yes, release the ${tickets(job.have)}`, callback_data: `relok_${job.id}` }
      : { text: '✅ Yes, I paid — stop re-holding', callback_data: `paidok_${job.id}` };
    await setButtons({ inline_keyboard: [[yes], [{ text: '↩️ No, keep holding', callback_data: `keep_${job.id}` }]] });
    return;
  }
  if (act === 'fin') {
    // Settle for what is in the cart: stop stacking, clean the cart, hand over the link.
    if (job.state !== 'held' || job.have >= job.qty) return;
    job.qty = job.have;
    await job.topping;
    await withCart(job, () => cleanCart(job)).catch(() => {});
    saveState();
    log(`🏁 ${jobName(job)}: stacking stopped by the user at ${tickets(job.have)}`);
    editJobMsgs(job, heldText(job), heldKb(job));
    return jobAction('co', job, chatId, msgId, fromMenu);
  }
  if (act === 'keep') {
    if (fromMenu) await tgEdit(chatId, jobsText(), jobsKb());
    else await setButtons(ownMsg ? (job.state === 'held' ? heldKb(job) : stopKb(job)) : payKb(job));
    return;
  }
  if (act === 'paid' || act === 'paidok') {
    if (job.state !== 'held') return;
    await stopJob(job, { keep: true, head: '💳 <b>Paid</b> — re-holding stopped' });
    dropButtons();
  } else if (act === 'resume') {
    if (job.state === 'held' && job.paying) {
      resumeReholds(job);
      log(`▶️ Re-holding resumed for ${jobName(job)}`);
      tgSend('editMessageText', { chat_id: chatId, message_id: msgId, text: `▶️ Re-holding resumed — ${jobName(job)}` }).catch(() => {});
    } else {
      dropButtons();
    }
  } else {
    await stopJob(job);
  }
  if (fromMenu) await tgEdit(chatId, jobsText(), jobsKb());
}

async function handleCallback(q) {
  const d = q.data || '';
  const chatId = q.message?.chat?.id;
  if (!chatId) return;
  if (!authorized(chatId, q.from?.id)) {
    await tgSend('answerCallbackQuery', { callback_query_id: q.id, text: 'Not authorized' }).catch(() => {});
    return;
  }
  await tgSend('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
  const msgId = q.message.message_id;
  const fromMenu = msgId === S.menuMsgs[chatId];

  const jb = d.match(/^(co|paid|paidok|rel|relok|keep|stop|resume|fin)_(\d+)$/);
  if (jb) {
    const job = S.jobs.find((j) => j.id === Number(jb[2]) && j.state !== 'done');
    if (job) return jobAction(jb[1], job, chatId, msgId, fromMenu);
    if (fromMenu) return tgEdit(chatId, jobsText(), jobsKb());
    await tgSend('editMessageText', { chat_id: chatId, message_id: msgId, text: '⚪ This job is no longer active.' }).catch(() => {});
    return;
  }

  let m;
  if (d === 'menu') {
    await tgEdit(chatId, mainMenuText(), mainMenuKb());
  } else if (d.startsWith('dates_')) {
    await showDates(chatId, parseInt(d.split('_')[1]) || 0);
  } else if ((m = d.match(/^d_(\d{4}-\d\d-\d\d)$/))) {
    await showDay(chatId, m[1]);
  } else if ((m = d.match(/^s_(\d{4}-\d\d-\d\d)_(\d\d:\d\d)$/))) {
    const [, date, time] = m;
    let found;
    try { found = await findSlot(date, time); } catch (e) {
      await tgEdit(chatId, `⚠️ Could not load ${date}: ${esc(noteError(e))}`, backKb(`d_${date}`));
      return;
    }
    const { day, slot } = found;
    const no = !slot ? 'The site no longer lists this time'
      : isPast(date, time) ? `${time} has already passed`
        : !cmCandidates(day.cm, slot).length ? `${time} can't be paired: no Carcere time ${CM_GAP_MIN}+ min before it` : '';
    if (no) { await tgEdit(chatId, `⛔ ${no}`, backKb(`d_${date}`)); return; }
    await tgEdit(chatId, `🎯 <b>${date} · 🏛️ ${time}</b>\nHow many tickets in one cart?`, qtyKb(date, time));
  } else if ((m = d.match(/^q_(\d{4}-\d\d-\d\d)_(\d\d:\d\d)_(\d)$/))) {
    const [, date, time] = m;
    const qty = Number(m[3]);
    if (!(qty >= 1 && qty <= MAX_QTY)) return;
    // A double tap must not start the same hunt twice.
    const key = `${chatId}|${date}|${time}|${qty}`;
    if (S.lastStart?.key === key && Date.now() - S.lastStart.at < 5000) return;
    S.lastStart = { key, at: Date.now() };
    try {
      const { slot } = await findSlot(date, time);
      if (!slot) throw new Error('The site no longer lists this time');
      await startJob(date, slot, qty);
    } catch (e) {
      await tgEdit(chatId, `⚠️ Could not start: ${esc(noteError(e))}`, backKb(`d_${date}`));
      return;
    }
    await showDay(chatId, date);
  } else if (d === 'jobs') {
    await tgEdit(chatId, jobsText(), jobsKb());
  } else if (d === 'ref') {
    await tgEdit(chatId, '⏳ Refreshing...', { inline_keyboard: [] });
    await refreshCalendar().catch((e) => log(`⚠️ Calendar: ${errText(e)}`));
    await tgEdit(chatId, mainMenuText(), mainMenuKb());
  }
}

async function handleCommand(msg) {
  const chatId = msg.chat?.id;
  if (!chatId || !authorized(chatId, msg.from?.id)) return;
  const cmd = (msg.text || '').split('@')[0].split(' ')[0].toLowerCase();
  if (cmd === '/start' || cmd === '/menu') {
    S.menuMsgs[chatId] = null;
    await tgEdit(chatId, mainMenuText(), mainMenuKb());
  } else if (cmd === '/jobs' || cmd === '/holds') {
    S.menuMsgs[chatId] = null;
    await tgEdit(chatId, jobsText(), jobsKb());
  } else if (cmd === '/refresh') {
    S.menuMsgs[chatId] = null;
    await tgEdit(chatId, '⏳ Refreshing...', { inline_keyboard: [] });
    await refreshCalendar().catch((e) => log(`⚠️ Calendar: ${errText(e)}`));
    await tgEdit(chatId, mainMenuText(), mainMenuKb());
  }
}

// ── Telegram polling ───────────────────────────────────
async function tgPollLoop() {
  for (;;) {
    try {
      const j = await tgSend('getUpdates', { timeout: 25, offset: S.offset, allowed_updates: ['callback_query', 'message'] });
      if (!j.ok) {
        log(`TG poll error: ${j.description || 'no response'}`);
        await sleep(5000);
        continue;
      }
      // Not awaited, so a slow handler never blocks Stop/Release.
      for (const u of j.result) {
        S.offset = u.update_id + 1;
        if (u.callback_query) handleCallback(u.callback_query).catch((e) => log(`TG error: ${errText(e)}`));
        if (u.message?.text) handleCommand(u.message).catch((e) => log(`TG error: ${errText(e)}`));
      }
    } catch {
      await sleep(5000);
    }
  }
}

// ── Cleanup ────────────────────────────────────────────
// Holds stay on the site and hunts resume on the next start. In-flight requests are
// allowed to finish first, so a catch made during shutdown is kept instead of orphaned.
async function cleanup() {
  if (S.stopping) { saveState(); process.exit(0); }
  S.stopping = true;
  console.log(`\n${stamp()} Shutting down — finishing in-flight requests (Ctrl+C again to skip)...`);
  // Long enough for a re-hold that has just freed its seats to catch them and finish the cart.
  await Promise.race([Promise.allSettled([...S.workers]), sleep(25000)]);
  saveState();
  log(`Saved ${liveJobs().length} job(s) for restore`);
  if (S.scoutClient) S.scoutClient.close();
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, cleanup);
rl.on('SIGINT', cleanup);
process.on('unhandledRejection', (e) => log(`⚠️ Unhandled: ${errText(e)}`));

// ── Main ───────────────────────────────────────────────
(async () => {
  log('Starting Omnia Sniper...');
  if (PROXY) log(`Proxy: ${PROXY.split('@')[1] || PROXY} (new IP per session)`);
  else log('No proxy — direct mode');
  log(`Up to ${WORKERS} requests in flight, shared by all hunts${GAP_MS ? `, ${GAP_MS}ms gap` : ''}; re-hold every ${Math.round(KEEPALIVE_MS / 1000)}s`);

  startCheckoutProxy();
  startAdmin();
  await startTunnel();

  if (TOKEN) {
    await tgSend('getMe', {});
    S.owner = Number(await resolveChat(TOKEN, process.env.TELEGRAM_CHAT_ID));
    S.chats.add(S.owner);
    log(`Telegram: chat ${S.owner}`);
  } else {
    log('No TELEGRAM_BOT_TOKEN — Telegram disabled');
  }

  // Restore before the bot listens, so an early tap can't save an empty state.
  await loadState();
  setInterval(statusTicker, 2000);
  setInterval(() => maintain().catch((e) => log(`⚠️ Maintenance: ${errText(e)}`)), 60e3);

  if (TOKEN) {
    S.offset = await drainUpdates(TOKEN);
    await tgSend('setMyCommands', { commands: [
      { command: 'menu', description: 'Open sniper menu' },
      { command: 'jobs', description: 'Hunting and held jobs' },
      { command: 'refresh', description: 'Refresh calendar' },
    ] });
    tgPollLoop();
    await tgEdit(S.owner, `${mainMenuText()}\nBot started`, mainMenuKb());
  }

  await refreshCalendar().catch((e) => log(`⚠️ Calendar fetch failed: ${errText(e)} — use Refresh`));
  await cliMain();
})().catch((e) => { console.error(`Fatal: ${errText(e)}`); process.exit(1); });
