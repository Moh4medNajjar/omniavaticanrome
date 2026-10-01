// Ticket-drop monitor for omniavaticanrome.org (Carcer Tullianum + Colosseo card).
// Read-only by default: it never calls vouchers/create_or_update, so it never holds or books tickets.
// Proof-of-concept exception: with HOLD_SECONDS set, on a drop it holds one order of tickets (by default the
// card's per-order maximum) in each area that dropped, waits HOLD_SECONDS, then releases everything.
// A "drop" = a date that was blocked in the booking calendar (exclude_days) becomes bookable
// and get_availability confirms it has time slots.
//
// Usage:  node monitor.js            (runs forever)
//         node monitor.js --once     (single check, useful for testing)
// Config via env vars (see README.md).

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const BASE = 'https://www.omniavaticanrome.org';
const LOC = 'it';
const CARD_SLUG = 'carcer-tullianum-colosseo-foro-romano-e-palatino';
const CARD_ID = 10;
const AREAS = {
  CM: { name: 'Carcere Mamertino', code: '30.97.01' },
  CL: { name: 'Colosseo', code: '30.97.05' },
};
const INTERVAL_MIN = Number(process.env.INTERVAL_MIN || 10); // be polite: default 10 min
const HORIZON_DAYS = Number(process.env.HORIZON_DAYS || 400);
const WATCH_DATES = (process.env.WATCH_DATES || '').split(',').map((s) => s.trim()).filter(Boolean); // YYYY-MM-DD
const HOLD_SECONDS = Math.min(Number(process.env.HOLD_SECONDS || 0), 60); // 0 = read-only (default)
const HOLD_QTY = Number(process.env.HOLD_QTY || 0); // tickets per area in the PoC hold; 0 = the card's per-order maximum
// Party the session is opened for. In hold mode openSession() replaces it with HOLD_QTY adults,
// so the calendar and the slots are the ones that fit the whole order.
let pax = { adult: 1, child: 1 };
const paxTotal = () => pax.adult + pax.child;
const products = (area) => `${AREAS[area].code}_${HOLD_SECONDS > 0 ? pax.adult : 1}`; // code_qty, as the booking page sends it
const STATE_FILE = path.join(__dirname, 'state.json');
const LOG_FILE = path.join(__dirname, 'monitor.log');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

const log = (msg) => fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- minimal cookie-jar HTTP client ----------
const jar = {};
async function http(method, url, { form, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    redirect: 'manual',
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'it-IT,it;q=0.9',
      Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}),
      ...headers,
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  return { status: res.status, location: res.headers.get('location'), text: await res.text() };
}

// ---------- site flow (read-only steps only) ----------
let csrf = null;
async function openSession() {
  for (const k of Object.keys(jar)) delete jar[k];
  const card = await http('GET', `${BASE}/${LOC}/cards/${CARD_SLUG}`);
  if (card.status !== 200) throw new Error(`card page ${card.status}`);
  const formToken = card.text.match(/name="authenticity_token" value="([^"]+)"/)?.[1];
  if (!formToken) throw new Error('no form token on card page');
  const maxLimit = Number(card.text.match(/name="max_limit" id="max_limit" value="(\d+)"/)?.[1] || 7); // the site's per-order limit
  if (HOLD_SECONDS > 0) pax = { adult: Math.max(1, Math.min(HOLD_QTY || maxLimit, maxLimit)), child: 0 };
  // set_pax only stores ticket quantities in the session; it does not hold inventory.
  const setPax = await http('POST', `${BASE}/${LOC}/cards/set_pax`, {
    form: { utf8: '✓', authenticity_token: formToken, card: CARD_ID, locale: LOC, max_limit: maxLimit, min_limit: 0, ...pax, student: 0, newborn: 0, commit: 'Acquista' },
  });
  if (setPax.status !== 302) throw new Error(`set_pax ${setPax.status}`);
  const mt = await http('GET', `${BASE}/${LOC}/cards/multitickets`);
  csrf = mt.text.match(/name="csrf-token" content="([^"]+)"/)?.[1];
  if (mt.status !== 200 || !csrf) throw new Error(`multitickets ${mt.status}`);
}

const xhr = () => ({ 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': csrf });

async function excludedDays(area) {
  const r = await http('POST', `${BASE}/${LOC}/vouchers/reserve`, {
    headers: xhr(),
    form: { area, buy_products: products(area), multibook: 'multitickets' },
  });
  if (r.status !== 200) throw Object.assign(new Error(`reserve ${area} ${r.status}`), { session: true });
  const m = r.text.match(/exclude_days\s*=\s*(\[[^\]]*\])/);
  if (!m) throw new Error(`reserve ${area}: exclude_days not found`);
  return new Set(JSON.parse(m[1]));
}

async function slots(area, isoDate) {
  const [y, mo, d] = isoDate.split('-');
  const r = await http('POST', `${BASE}/${LOC}/cards/get_availability`, {
    headers: xhr(),
    form: { area, data: `${d}-${mo}-${y}`, groups: 'IND', layout: 'horizontal', number_of_pax: paxTotal() },
  });
  if (r.status !== 200) throw Object.assign(new Error(`get_availability ${area} ${r.status}`), { session: true });
  return [...r.text.matchAll(/id='(GRP_\d+_IND_[\d-]+_(\d\d:\d\d))'/g)].map((m) => ({ id: m[1], time: m[2] }));
}

// ---------- proof-of-concept hold (only runs when HOLD_SECONDS > 0) ----------
const activeHolds = []; // { area, codes, what, csrf } for every order currently held
let releaseRounds = 0; // failed release rounds for the current holds
const mins = (t) => +t.slice(0, 2) * 60 + +t.slice(3);

// Holds one order (pax.adult tickets) for the slot. This is the only call that reserves real seats.
async function placeHold(area, isoDate, slot) {
  const [y, mo, d] = isoDate.split('-');
  const what = `${pax.adult} × ${AREAS[area].name} ${isoDate} ${slot.time}`;
  await http('POST', `${BASE}/${LOC}/vouchers/reserve`, {
    headers: xhr(),
    form: { area, buy_products: products(area), multibook: 'multitickets' },
  });
  const r = await http('POST', `${BASE}/${LOC}/vouchers/create_or_update`, {
    headers: xhr(),
    form: { utf8: '✓', authenticity_token: csrf, buy_area: area, buy_group_type_code: '', buy_reservation_date: `${d}-${mo}-${y}`,
      buy_group_name: slot.id, buy_products: products(area), multibook: 'multitickets' },
  });
  let j; try { j = JSON.parse(r.text); } catch { j = {}; }
  const codes = [...new Set((j.html || '').match(/RS[A-Z]{2}\d+[A-Z]/g) || [])];
  if (r.status !== 200 || !codes.length || j.hold === 'ko') {
    log(`HOLD failed ${what} status=${r.status}`);
    return `PoC: hold non riuscito per ${what} (HTTP ${r.status})`;
  }
  activeHolds.push({ area, codes, what, csrf });
  log(`HOLD ${what} ${codes.join(',')}`);
  return `PoC: trattenuti ${what} (${codes.join(', ')})`;
}

// True when the server no longer lists the reservation codes.
async function releaseHold(h) {
  const r = await http('POST', `${BASE}/${LOC}/vouchers/delete_reservations`, {
    headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': h.csrf },
    form: { utf8: '✓', authenticity_token: h.csrf, reservations: h.codes.join('**'), buy_area: h.area },
  });
  let j; try { j = JSON.parse(r.text); } catch { j = null; }
  return r.status === 200 && j !== null && !h.codes.some((c) => (j.html || '').includes(c));
}

// Releases every held order, up to 3 attempts each. Returns the holds that are still not confirmed released.
async function releaseAll() {
  for (const h of [...activeHolds]) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const freed = await releaseHold(h).catch(() => false);
      log(`${freed ? 'RELEASED' : `RELEASE NOT CONFIRMED (attempt ${attempt})`} ${h.what} ${h.codes.join(',')}`);
      if (freed) { activeHolds.splice(activeHolds.indexOf(h), 1); break; }
      await sleep(2000);
    }
  }
  return activeHolds;
}

// targets: { CM?: { date, slots }, CL?: { date, slots } }. Holds each area that dropped, waits, releases all.
// It never throws: a hold error must not fail the check, or the same drop would be held again next time.
async function holdBriefly(targets) {
  const lines = [];
  try {
    let cm = null; // the Carcere hold, if one was placed
    for (const area of Object.keys(AREAS)) {
      const t = targets[area];
      if (!t) continue;
      // On the same day the Colosseo entry must be at least 1h after the Carcere one
      const later = area === 'CL' && cm?.date === t.date ? t.slots.find((x) => mins(x.time) - mins(cm.time) >= 60) : null;
      const slot = later || t.slots[0];
      const before = activeHolds.length;
      lines.push(await placeHold(area, t.date, slot));
      if (area === 'CM' && activeHolds.length > before) cm = { date: t.date, time: slot.time };
    }
    if (activeHolds.length) await sleep(HOLD_SECONDS * 1000);
  } catch (e) {
    log(`HOLD error ${e.message}`);
    lines.push(`PoC: errore durante l'hold: ${e.message}`);
  } finally {
    const held = activeHolds.length;
    const stuck = await releaseAll().catch(() => activeHolds);
    if (stuck.length) lines.push(`PoC: ⚠️ RILASCIO NON CONFERMATO, riprovo al prossimo controllo: ${stuck.map((h) => `${h.what} (${h.codes.join(', ')})`).join('; ')}`);
    else if (held) lines.push(`PoC: tutto rilasciato dopo ${HOLD_SECONDS}s`);
  }
  return lines;
}

// Ctrl+C or a termination signal while tickets are held still releases them
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(sig, async () => {
    if (activeHolds.length) await releaseAll().catch(() => {});
    process.exit(0);
  });
}

// ---------- notifications ----------
async function notify(title, body) {
  log(`ALERT ${title} | ${body.replace(/\n/g, ' | ')}`);
  // Windows desktop toast (no dependencies)
  if (process.platform === 'win32') {
    const ps = `Add-Type -AssemblyName System.Windows.Forms; $n=New-Object System.Windows.Forms.NotifyIcon; $n.Icon=[System.Drawing.SystemIcons]::Information; $n.Visible=$true; $n.ShowBalloonTip(15000, $env:T, $env:B, 'Info'); Start-Sleep 16; $n.Dispose()`;
    execFile('powershell', ['-NoProfile', '-Command', ps], { env: { ...process.env, T: title, B: body.slice(0, 250) } }, () => {});
  }
  // Telegram (optional)
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: `${title}\n${body}\n${BASE}/${LOC}/cards/${CARD_SLUG}` }),
    }).catch((e) => log(`telegram error ${e.message}`));
  }
  // Generic webhook, e.g. Discord (optional)
  if (process.env.WEBHOOK_URL) {
    await fetch(process.env.WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `**${title}**\n${body}\n${BASE}/${LOC}/cards/${CARD_SLUG}` }),
    }).catch((e) => log(`webhook error ${e.message}`));
  }
}

// ---------- one check ----------
function openDates(excluded) {
  const out = [];
  const d = new Date();
  for (let i = 0; i < HORIZON_DAYS; i++, d.setDate(d.getDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    if (!excluded.has(iso)) out.push(iso);
  }
  return out;
}

async function check(state) {
  // Holds left over from a failed release come first, on the session that placed them (a new session cannot release them).
  if (activeHolds.length && (await releaseAll()).length) {
    if (++releaseRounds < 6) throw new Error('held tickets still not released');
    await notify('⚠️ Rilascio non riuscito', `Rinuncio dopo ${releaseRounds} tentativi: ${activeHolds.map((h) => `${h.what} (${h.codes.join(', ')})`).join('; ')}`);
    activeHolds.length = 0;
  }
  releaseRounds = 0;
  if (!csrf) await openSession();
  // Availability depends on the party size, so a different party needs a new baseline
  if ((state.pax ?? 2) !== paxTotal()) { state.open = {}; state.watch = {}; log(`party size ${state.pax ?? 2} -> ${paxTotal()}: new baseline`); }
  state.pax = paxTotal();
  const alerts = [];
  const targets = {}; // per area, the first newly available date and its slots: { date, slots }
  for (const area of Object.keys(AREAS)) {
    const open = openDates(await excludedDays(area));
    const prev = new Set(state.open?.[area] || []);
    const newlyOpen = state.open?.[area] ? open.filter((d) => !prev.has(d)) : []; // first run = baseline only
    // Confirm new dates actually have slots (cap to avoid hammering the site on a big release)
    const confirmed = [];
    for (const d of newlyOpen.slice(0, 5)) { const s = await slots(area, d); if (s.length) { confirmed.push(`${d} (${s.length} slot)`); targets[area] ||= { date: d, slots: s }; } await sleep(1500); }
    if (newlyOpen.length) alerts.push(`${AREAS[area].name}: ${newlyOpen.length} nuove date (${newlyOpen[0]} → ${newlyOpen.at(-1)})${confirmed.length ? '\n  verificate: ' + confirmed.join(', ') : ''}`);
    // Watched dates: alert when a watched date goes from no slots to slots
    for (const d of WATCH_DATES) {
      const s = open.includes(d) ? await slots(area, d) : [];
      const key = `${area}:${d}`;
      if (s.length && !(state.watch?.[key] > 0)) { alerts.push(`${AREAS[area].name}: ${d} ora disponibile (${s.map((x) => x.time).join(', ')})`); targets[area] ||= { date: d, slots: s }; }
      (state.watch ||= {})[key] = s.length;
    }
    (state.open ||= {})[area] = open;
    state.lastOpen = { ...(state.lastOpen || {}), [area]: open.at(-1) };
  }
  if (HOLD_SECONDS > 0 && Object.keys(targets).length) alerts.push(...(await holdBriefly(targets)));
  state.lastCheck = new Date().toISOString();
  if (alerts.length) await notify('🎟️ Nuovi biglietti disponibili', alerts.join('\n'));
  log(`ok CM last=${state.lastOpen.CM} CL last=${state.lastOpen.CL}`);
}

// ---------- main loop ----------
(async () => {
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  let failures = 0;
  for (;;) {
    try {
      await check(state);
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      failures = 0;
    } catch (e) {
      failures++;
      csrf = null; // force a fresh session next time
      log(`error (${failures}) ${e.message}`);
      if (failures === 5) await notify('⚠️ Monitor in errore', `5 errori consecutivi: ${e.message}`);
    }
    if (process.argv.includes('--once')) break;
    // Back off on repeated errors; small jitter so requests aren't perfectly periodic
    // ...except while a release is pending: then retry it quickly
    const wait = activeHolds.length ? 30000 : INTERVAL_MIN * 60000 * Math.min(2 ** Math.max(0, failures - 1), 8) + Math.random() * 60000;
    await sleep(wait);
  }
})();
