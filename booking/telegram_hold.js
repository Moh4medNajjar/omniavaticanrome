// Proof of concept: hold one adult ticket (Carcere + Colosseo), then post a Telegram message with two buttons.
//   "Open checkout" opens a browser window ON THIS PC at the site's checkout page, with the held cart.
//   "Release" frees the seats and ends the script.
// The hold is also released on Ctrl+C, and automatically after AUTO_RELEASE_MIN if nothing else happened
// (the site itself drops an idle hold after 15 minutes, see recon/HOLD_TTL.md).
// It never touches /vouchers/pay: paying, if you want to, is done by hand in the browser window.
//
// Why the button cannot be a plain link: the cart belongs to the session cookie, and a link cannot carry a
// cookie into another browser. So the button talks to this script, and this script opens the browser.
//
//   set TELEGRAM_BOT_TOKEN (from @BotFather) and optionally TELEGRAM_CHAT_ID, then:
//   node telegram_hold.js [--date YYYY-MM-DD]     hold, post the buttons, wait for a click
//   node telegram_hold.js --release                release the hold of the last run (fallback)

const fs = require('fs');
const path = require('path');

const BASE = 'https://www.omniavaticanrome.org';
const LOC = 'it';
const CARD_SLUG = 'carcer-tullianum-colosseo-foro-romano-e-palatino';
const CARD_ID = 10;
const PRODUCTS = { CM: '30.97.01_1', CL: '30.97.05_1' }; // one adult per area
const NAMES = { CM: 'Carcere Mamertino', CL: 'Colosseo' };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const AUTO_RELEASE_MIN = 16;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const STATE_DIR = path.join(__dirname, '..', 'recon', 'out', 'telegram_hold'); // gitignored: holds the session cookie
const STATE_FILE = path.join(STATE_DIR, 'session.json');

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (msg) => console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);
const mins = (t) => +t.slice(0, 2) * 60 + +t.slice(3);

// ---------- site ----------
function client(jar) {
  return async (method, url, { form, headers = {} } = {}) => {
    const res = await fetch(BASE + url, {
      method, redirect: 'manual', body: form ? new URLSearchParams(form).toString() : undefined,
      headers: { 'User-Agent': UA, 'Accept-Language': 'it-IT,it;q=0.9', Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}), ...headers },
    });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); }
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  };
}

// Releases every hold in the state. True when the server no longer lists any of the codes.
async function release(st) {
  const http = client(st.jar);
  let all = true;
  for (const [area, codes] of Object.entries(st.holds)) {
    const d = await http('POST', `/${LOC}/vouchers/delete_reservations`, {
      headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': st.csrf },
      form: { utf8: '✓', authenticity_token: st.csrf, reservations: codes.join('**'), buy_area: area },
    });
    let j; try { j = JSON.parse(d.text); } catch { j = null; }
    const gone = d.status === 200 && j !== null && !codes.some((c) => (j.html || '').includes(c));
    step(`release ${NAMES[area]} ${codes.join(', ')}: HTTP ${d.status}, ${gone ? 'no longer listed' : 'NOT CONFIRMED'}`);
    all &&= gone;
  }
  st.releasedAt = new Date().toISOString();
  st.releaseConfirmed = all;
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
  return all;
}

// Holds one adult in both areas on `day` (or the first roomy day about six weeks out). Saves the session after each hold.
async function hold(day) {
  const st = { jar: {}, holds: {}, times: {} };
  const http = client(st.jar);
  const card = await http('GET', `/${LOC}/cards/${CARD_SLUG}`);
  const formToken = card.text.match(/name="authenticity_token" value="([^"]+)"/)?.[1];
  if (card.status !== 200 || !formToken) throw new Error(`card page failed (${card.status})`);
  const pax = await http('POST', `/${LOC}/cards/set_pax`, { form: { utf8: '✓', authenticity_token: formToken, card: CARD_ID, locale: LOC, max_limit: 7, min_limit: 0, adult: 1, child: 0, student: 0, newborn: 0, commit: 'Acquista' } });
  if (pax.status !== 302) throw new Error(`set_pax failed (${pax.status})`);
  const mt = await http('GET', `/${LOC}/cards/multitickets`);
  st.csrf = mt.text.match(/name="csrf-token" content="([^"]+)"/)?.[1];
  if (!st.csrf) throw new Error('could not read booking page');
  const xhr = { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': st.csrf };
  const widget = (area) => http('POST', `/${LOC}/vouchers/reserve`, { headers: xhr, form: { area, buy_products: PRODUCTS[area], multibook: 'multitickets' } });
  // number_of_pax=7 lists only slots with at least 7 seats left, so the test never takes a scarce seat
  const roomy = async (area, d) => {
    const [Y, M, D] = d.split('-');
    const a = await http('POST', `/${LOC}/cards/get_availability`, { headers: xhr, form: { area, data: `${D}-${M}-${Y}`, groups: 'IND', layout: 'horizontal', number_of_pax: 7 } });
    return [...a.text.matchAll(/id='(GRP_\d+_IND_[\d-]+_(\d\d:\d\d))'/g)].map((m) => ({ id: m[1], time: m[2] }));
  };
  if (!day) {
    const excluded = new Set();
    for (const area of ['CM', 'CL']) for (const x of JSON.parse((await widget(area)).text.match(/exclude_days\s*=\s*(\[[^\]]*\])/)?.[1] || '[]')) excluded.add(x);
    const d = new Date(); d.setDate(d.getDate() + 42);
    while (excluded.has(d.toISOString().slice(0, 10))) d.setDate(d.getDate() + 1);
    day = d.toISOString().slice(0, 10);
  }
  st.day = day;
  const [Y, M, D] = day.split('-');
  try {
    for (const area of ['CM', 'CL']) {
      await widget(area);
      const slots = await roomy(area, day);
      // Carcere mid-morning; Colosseo at least 90 minutes later (the site asks for at least an hour)
      const slot = area === 'CM' ? slots[Math.floor(slots.length / 3)] : slots.find((s) => mins(s.time) - mins(st.times.CM) >= 90);
      if (!slot) throw new Error(`no roomy ${NAMES[area]} slot on ${day}`);
      const r = await http('POST', `/${LOC}/vouchers/create_or_update`, { headers: xhr,
        form: { utf8: '✓', authenticity_token: st.csrf, buy_area: area, buy_group_type_code: '', buy_reservation_date: `${D}-${M}-${Y}`, buy_group_name: slot.id, buy_products: PRODUCTS[area], multibook: 'multitickets' } });
      let j; try { j = JSON.parse(r.text); } catch { j = {}; }
      const known = Object.values(st.holds).flat();
      const codes = [...new Set((j.html || '').match(/RS[A-Z]{2}\d+[A-Z]/g) || [])].filter((c) => !known.includes(c));
      if (r.status !== 200 || !codes.length || j.hold === 'ko') throw new Error(`${NAMES[area]} hold failed (HTTP ${r.status})`);
      st.holds[area] = codes; st.times[area] = slot.time; st.checkoutUrl = j.url || `/${LOC}/vouchers/checkout`;
      st.heldAt = new Date().toISOString();
      fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
      step(`held ${NAMES[area]} ${day} ${slot.time}: ${codes.join(', ')}`);
    }
  } catch (e) {
    if (Object.keys(st.holds).length) await release(st);
    throw e;
  }
  return st;
}

// ---------- telegram ----------
async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(`telegram ${method}: ${j.description || res.status}`);
  return j.result;
}

// The chat to talk to: TELEGRAM_CHAT_ID, or whoever sends the bot a message first.
async function findChat() {
  if (process.env.TELEGRAM_CHAT_ID) return { chat: Number(process.env.TELEGRAM_CHAT_ID), offset: 0 };
  step('TELEGRAM_CHAT_ID is not set: send any message (for example /start) to your bot now...');
  for (let offset = 0; ;) {
    for (const u of await tg('getUpdates', { timeout: 25, offset })) {
      offset = u.update_id + 1;
      if (u.message?.chat?.id) { step(`using chat ${u.message.chat.id} (set TELEGRAM_CHAT_ID to this to skip the step)`); return { chat: u.message.chat.id, offset }; }
    }
  }
}

// ---------- main ----------
(async () => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (process.argv.includes('--release')) {
    const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    process.exit((await release(st)) ? 0 : 1);
  }
  if (!TOKEN) { console.log('Set TELEGRAM_BOT_TOKEN first (create a bot with @BotFather).'); process.exit(1); }
  await tg('getMe', {}); // fail early on a bad token, before anything is held
  let { chat, offset } = await findChat();

  const st = await hold(arg('date'));
  let browser = null;
  let done = false;
  const summary = `${NAMES.CM} ${st.times.CM} (${st.holds.CM.join(', ')})\n${NAMES.CL} ${st.times.CL} (${st.holds.CL.join(', ')})`;
  const msg = await tg('sendMessage', {
    chat_id: chat,
    text: `🎟️ Ticket held: 1 adult, ${st.day}\n${summary}\n\nThe site drops the hold after 15 minutes; this test releases it after ${AUTO_RELEASE_MIN} at the latest.`,
    reply_markup: { inline_keyboard: [[{ text: '🛒 Open checkout', callback_data: 'open' }], [{ text: '❌ Release', callback_data: 'release' }]] },
  });
  step('Telegram message sent; waiting for a button');

  const finish = async (why) => {
    if (done) return;
    done = true;
    const ok = await release(st).catch(() => false);
    await tg('editMessageText', { chat_id: chat, message_id: msg.message_id, text: `${ok ? '✅ Released' : '⚠️ Release NOT confirmed'} (${why}): 1 adult, ${st.day}\n${summary}` }).catch((e) => step(e.message));
    if (browser) await browser.close().catch(() => {});
    process.exit(ok ? 0 : 1);
  };
  process.on('SIGINT', () => finish('Ctrl+C'));
  setTimeout(() => finish(`automatic, ${AUTO_RELEASE_MIN} min`), AUTO_RELEASE_MIN * 60000);

  while (!done) {
    const updates = await tg('getUpdates', { timeout: 25, offset, allowed_updates: ['callback_query', 'message'] }).catch((e) => { step(e.message); return sleep(3000).then(() => []); });
    for (const u of updates) {
      offset = u.update_id + 1;
      const q = u.callback_query;
      if (!q || q.message?.chat?.id !== chat || q.message?.message_id !== msg.message_id) continue; // only this chat, only this message
      if (q.data === 'release') { await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Releasing…' }).catch(() => {}); await finish('button'); }
      if (q.data === 'open') {
        await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Opening checkout on the PC running the bot' }).catch(() => {});
        if (!browser) {
          // Same hand-off as book.js: give the held session's cookies to a real browser window
          const { chromium } = require(path.join(__dirname, '..', 'recon', 'node_modules', 'playwright'));
          browser = await chromium.launch({ headless: false });
          const ctx = await browser.newContext({ locale: 'it-IT', userAgent: UA, viewport: null });
          await ctx.addCookies(Object.entries(st.jar).map(([name, value]) => ({ name, value, domain: 'www.omniavaticanrome.org', path: '/', secure: true })));
          const page = await ctx.newPage();
          await page.goto(BASE + st.checkoutUrl);
          browser.on('disconnected', () => { browser = null; });
          step('checkout opened in a browser window');
        }
      }
    }
  }
})().catch((e) => { console.error(`✖ ${e.message}`); process.exit(1); });
