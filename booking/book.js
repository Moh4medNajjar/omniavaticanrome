// Personal one-shot booking helper for the Carcer Tullianum + Colosseo card.
// It reserves the tickets through the site's own endpoints, then opens a normal browser window at
// checkout with that session so YOU enter your details and pay on the payment provider's page.
// It never touches /vouchers/pay or any payment data, and it makes exactly one attempt (no retries).
//
//   node book.js --date 2026-10-02                     -> list time slots only (holds nothing)
//   node book.js --date 2026-10-02 --cm 09:00 --cl 10:30   -> hold the tickets and open checkout
//   options: --adults 2 (default) --children 0

const path = require('path');

const BASE = 'https://www.omniavaticanrome.org';
const LOC = 'it';
const CARD_SLUG = 'carcer-tullianum-colosseo-foro-romano-e-palatino';
const CARD_ID = 10;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const DATE = arg('date');
const CM_TIME = arg('cm');
const CL_TIME = arg('cl');
const ADULTS = Number(arg('adults', 2));
const CHILDREN = Number(arg('children', 0));
if (!/^\d{4}-\d\d-\d\d$/.test(DATE || '')) { console.log('usage: node book.js --date YYYY-MM-DD [--cm HH:MM --cl HH:MM]'); process.exit(1); }
const [Y, M, D] = DATE.split('-');
const DMY = `${D}-${M}-${Y}`;

// ---------- cookie-jar HTTP client (same mechanics the browser uses) ----------
const jar = {};
async function http(method, url, { form, headers = {} } = {}) {
  const body = form ? new URLSearchParams(form).toString() : undefined;
  const res = await fetch(url, {
    method, redirect: 'manual', body,
    headers: {
      'User-Agent': UA, 'Accept-Language': 'it-IT,it;q=0.9',
      Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}),
      ...headers,
    },
  });
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(';'); const i = kv.indexOf('=');
    jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  return { status: res.status, text: await res.text() };
}
let csrf;
const xhr = () => ({ 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': csrf });
const step = (msg) => console.log(`• ${msg}`);

(async () => {
  // 1. Card page -> session cookie + form token
  const card = await http('GET', `${BASE}/${LOC}/cards/${CARD_SLUG}`);
  const formToken = card.text.match(/name="authenticity_token" value="([^"]+)"/)?.[1];
  if (card.status !== 200 || !formToken) throw new Error(`card page failed (${card.status})`);
  step('session opened');

  // 2. Ticket quantities -> stored in the session (no hold yet)
  const pax = await http('POST', `${BASE}/${LOC}/cards/set_pax`, {
    form: { utf8: '✓', authenticity_token: formToken, card: CARD_ID, locale: LOC, max_limit: 7, min_limit: 0,
      adult: ADULTS, child: CHILDREN, student: 0, newborn: 0, commit: 'Acquista' },
  });
  if (pax.status !== 302) throw new Error(`set_pax failed (${pax.status})`);

  // 3. Booking page -> CSRF token + exact product codes per area (read from the page, not hard-coded)
  const mt = await http('GET', `${BASE}/${LOC}/cards/multitickets`);
  csrf = mt.text.match(/name="csrf-token" content="([^"]+)"/)?.[1];
  const products = {};
  const parts = mt.text.split(/<form action="\/\w+\/vouchers\/reserve"/);
  for (let i = 1; i < parts.length; i++) {
    const area = parts[i].match(/name="area" id="area" value="(\w+)"/)?.[1];
    // the elements[] (code_qty) of an area sit just before its "Prenota" form
    const els = [...parts[i - 1].matchAll(/name="elements\[\]" id="elements_" value="([^"]+)"/g)].map((m) => m[1]);
    products[area] ||= [...new Set(els)].filter((e) => !e.endsWith('_0')).join('**');
  }
  if (!csrf || !products.CM || !products.CL) throw new Error('could not read booking page');
  step(`tickets: Carcere Mamertino [${products.CM}]  Colosseo [${products.CL}]`);

  // 4. For each area: open widget, read slots for the date
  const slots = {};
  for (const area of ['CM', 'CL']) {
    const w = await http('POST', `${BASE}/${LOC}/vouchers/reserve`, { headers: xhr(), form: { area, buy_products: products[area], multibook: 'multitickets' } });
    const excluded = JSON.parse(w.text.match(/exclude_days\s*=\s*(\[[^\]]*\])/)?.[1] || '[]');
    if (excluded.includes(DATE)) { slots[area] = []; continue; }
    const a = await http('POST', `${BASE}/${LOC}/cards/get_availability`, {
      headers: xhr(), form: { area, data: DMY, groups: 'IND', layout: 'horizontal', number_of_pax: ADULTS + CHILDREN },
    });
    slots[area] = [...a.text.matchAll(/id='(GRP_\d+_IND_[\d-]+_(\d\d:\d\d))'/g)].map((m) => ({ id: m[1], time: m[2] }));
  }
  console.log(`\nSlots on ${DATE} for ${ADULTS + CHILDREN} people:`);
  console.log(`  Carcere Mamertino (--cm): ${slots.CM.map((s) => s.time).join(' ') || 'none'}`);
  console.log(`  Colosseo          (--cl): ${slots.CL.map((s) => s.time).join(' ') || 'none'}`);
  console.log('  (Colosseo entry must be at least 1h after Carcere Mamertino)\n');
  if (!CM_TIME || !CL_TIME) { step('no times given: nothing was reserved'); return; }

  const cm = slots.CM.find((s) => s.time === CM_TIME);
  const cl = slots.CL.find((s) => s.time === CL_TIME);
  if (!cm || !cl) throw new Error('chosen time not available: nothing was reserved');
  const mins = (t) => +t.slice(0, 2) * 60 + +t.slice(3);
  if (mins(CL_TIME) - mins(CM_TIME) < 60) throw new Error('Colosseo must be at least 1h after Carcere Mamertino: nothing was reserved');

  // 5. Hold: create_or_update per area (this is the step that reserves real seats)
  const hold = async (area, slot) => {
    await http('POST', `${BASE}/${LOC}/vouchers/reserve`, { headers: xhr(), form: { area, buy_products: products[area], multibook: 'multitickets' } });
    const r = await http('POST', `${BASE}/${LOC}/vouchers/create_or_update`, {
      headers: xhr(),
      form: { utf8: '✓', authenticity_token: csrf, buy_area: area, buy_group_type_code: '', buy_reservation_date: DMY,
        buy_group_name: slot.id, buy_products: products[area], multibook: 'multitickets' },
    });
    let j; try { j = JSON.parse(r.text); } catch { j = {}; }
    const codes = [...new Set((j.html || '').match(/RS[A-Z]{2}\d+[A-Z]/g) || [])];
    return { ok: r.status === 200 && codes.length > 0 && j.hold !== 'ko', codes, url: j.url, html: j.html || '' };
  };
  const h1 = await hold('CM', cm);
  if (!h1.ok) throw new Error('Carcere Mamertino hold failed: nothing was reserved');
  step(`held Carcere Mamertino ${CM_TIME}: ${h1.codes.join(', ')}`);
  const h2 = await hold('CL', cl);
  if (!h2.ok) {
    // Release the first hold so no half-booking stays blocked
    await http('POST', `${BASE}/${LOC}/vouchers/delete_reservations`, {
      headers: xhr(), form: { utf8: '✓', authenticity_token: csrf, reservations: h1.codes.join('**'), buy_area: 'CM' },
    });
    throw new Error('Colosseo hold failed: the Carcere Mamertino hold was released');
  }
  step(`held Colosseo ${CL_TIME}: ${h2.codes.join(', ')}`);

  // 6. Hand the session to a real browser window at checkout; you fill in details and pay there
  const { chromium } = require(path.join(__dirname, '..', 'recon', 'node_modules', 'playwright'));
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ locale: 'it-IT', userAgent: UA, viewport: null });
  await ctx.addCookies(Object.entries(jar).map(([name, value]) => ({ name, value, domain: 'www.omniavaticanrome.org', path: '/', secure: true })));
  const page = await ctx.newPage();
  await page.goto(`${BASE}${h2.url || `/${LOC}/vouchers/checkout`}`);
  console.log('\n✔ Checkout is open in the browser window. Fill in your details, click "Procedi" and pay there.');
  console.log('  The site releases unpaid tickets 15 minutes after they were held (see recon/HOLD_TTL.md): pay before then.');
  console.log('  Close the browser window when you are done.');
  browser.on('disconnected', () => process.exit(0));
})().catch((e) => { console.error(`✖ ${e.message}`); process.exit(1); });
