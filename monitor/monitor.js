// Ticket-drop monitor for omniavaticanrome.org (Carcer Tullianum + Colosseo card).
// Read-only: it never calls vouchers/create_or_update, so it never holds or books tickets.
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
  CM: { name: 'Carcere Mamertino', products: '30.97.01_1' },
  CL: { name: 'Colosseo', products: '30.97.05_1' },
};
const INTERVAL_MIN = Number(process.env.INTERVAL_MIN || 10); // be polite: default 10 min
const HORIZON_DAYS = Number(process.env.HORIZON_DAYS || 400);
const WATCH_DATES = (process.env.WATCH_DATES || '').split(',').map((s) => s.trim()).filter(Boolean); // YYYY-MM-DD
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
  // set_pax only stores ticket quantities in the session; it does not hold inventory.
  const pax = await http('POST', `${BASE}/${LOC}/cards/set_pax`, {
    form: { utf8: '✓', authenticity_token: formToken, card: CARD_ID, locale: LOC, max_limit: 7, min_limit: 0, adult: 1, child: 1, student: 0, newborn: 0, commit: 'Acquista' },
  });
  if (pax.status !== 302) throw new Error(`set_pax ${pax.status}`);
  const mt = await http('GET', `${BASE}/${LOC}/cards/multitickets`);
  csrf = mt.text.match(/name="csrf-token" content="([^"]+)"/)?.[1];
  if (mt.status !== 200 || !csrf) throw new Error(`multitickets ${mt.status}`);
}

const xhr = () => ({ 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': csrf });

async function excludedDays(area) {
  const r = await http('POST', `${BASE}/${LOC}/vouchers/reserve`, {
    headers: xhr(),
    form: { area, buy_products: AREAS[area].products, multibook: 'multitickets' },
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
    form: { area, data: `${d}-${mo}-${y}`, groups: 'IND', layout: 'horizontal', number_of_pax: 2 },
  });
  if (r.status !== 200) throw Object.assign(new Error(`get_availability ${area} ${r.status}`), { session: true });
  return [...r.text.matchAll(/id='GRP_\d+_IND_[\d-]+_(\d\d:\d\d)'/g)].map((m) => m[1]);
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
  if (!csrf) await openSession();
  const alerts = [];
  for (const area of Object.keys(AREAS)) {
    const open = openDates(await excludedDays(area));
    const prev = new Set(state.open?.[area] || []);
    const newlyOpen = state.open?.[area] ? open.filter((d) => !prev.has(d)) : []; // first run = baseline only
    // Confirm new dates actually have slots (cap to avoid hammering the site on a big release)
    const confirmed = [];
    for (const d of newlyOpen.slice(0, 5)) { const s = await slots(area, d); if (s.length) confirmed.push(`${d} (${s.length} slot)`); await sleep(1500); }
    if (newlyOpen.length) alerts.push(`${AREAS[area].name}: ${newlyOpen.length} nuove date (${newlyOpen[0]} → ${newlyOpen.at(-1)})${confirmed.length ? '\n  verificate: ' + confirmed.join(', ') : ''}`);
    // Watched dates: alert when a watched date goes from no slots to slots
    for (const d of WATCH_DATES) {
      const s = open.includes(d) ? await slots(area, d) : [];
      const key = `${area}:${d}`;
      if (s.length && !(state.watch?.[key] > 0)) alerts.push(`${AREAS[area].name}: ${d} ora disponibile (${s.join(', ')})`);
      (state.watch ||= {})[key] = s.length;
    }
    (state.open ||= {})[area] = open;
    state.lastOpen = { ...(state.lastOpen || {}), [area]: open.at(-1) };
  }
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
    const wait = INTERVAL_MIN * 60000 * Math.min(2 ** Math.max(0, failures - 1), 8) + Math.random() * 60000;
    await sleep(wait);
  }
})();
