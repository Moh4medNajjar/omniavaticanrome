// One-shot booking helper for the Carcer Tullianum + Colosseo card.
// Reserves tickets, then opens a browser at checkout for you to pay manually.
// Never touches /vouchers/pay. Makes exactly one attempt.
//
//   node --env-file=.env book.js --date 2026-10-02                         list slots only
//   node --env-file=.env book.js --date 2026-10-02 --cm 09:00 --cl 10:30  hold + open checkout
//   Options: --adults 2 (default) --children 0

const { makeClient, arg, dmy, mins, BASE, LOC, CARD_SLUG, CARD_ID } = require('./lib/client');
const { openSession, xhrHeaders, reservationCodes } = require('./lib/site');

const DATE = arg('date');
const CM_TIME = arg('cm');
const CL_TIME = arg('cl');
const ADULTS = Number(arg('adults', 2));
const CHILDREN = Number(arg('children', 0));
if (!/^\d{4}-\d\d-\d\d$/.test(DATE || '')) { console.log('usage: node book.js --date YYYY-MM-DD [--cm HH:MM --cl HH:MM]'); process.exit(1); }

(async () => {
  const client = makeClient();
  const { http } = client;
  const { csrf, multitickets } = await openSession(client, { adults: ADULTS, children: CHILDREN });
  console.log('• session opened');

  // Parse product codes from the multitickets page
  const products = {};
  const parts = multitickets.split(/<form action="\/\w+\/vouchers\/reserve"/);
  for (let i = 1; i < parts.length; i++) {
    const area = parts[i].match(/name="area" id="area" value="(\w+)"/)?.[1];
    const els = [...parts[i - 1].matchAll(/name="elements\[\]" id="elements_" value="([^"]+)"/g)].map((m) => m[1]);
    products[area] ||= [...new Set(els)].filter((e) => !e.endsWith('_0')).join('**');
  }
  if (!products.CM || !products.CL) throw new Error('could not read booking page');
  console.log(`• tickets: CM [${products.CM}]  CL [${products.CL}]`);

  // Fetch slots for each area
  const slots = {};
  for (const area of ['CM', 'CL']) {
    await http('POST', `${BASE}/${LOC}/vouchers/reserve`, {
      headers: xhrHeaders(csrf), form: { area, buy_products: products[area], multibook: 'multitickets' },
    });
    const a = await http('POST', `${BASE}/${LOC}/cards/get_availability`, {
      headers: xhrHeaders(csrf), form: { area, data: dmy(DATE), groups: 'IND', layout: 'horizontal', number_of_pax: ADULTS + CHILDREN },
    });
    slots[area] = [...a.text.matchAll(/id='(GRP_\d+_IND_[\d-]+_(\d\d:\d\d))'/g)].map((m) => ({ id: m[1], time: m[2] }));
  }

  console.log(`\nSlots on ${DATE} for ${ADULTS + CHILDREN} people:`);
  console.log(`  Carcere Mamertino (--cm): ${slots.CM.map((s) => s.time).join(' ') || 'none'}`);
  console.log(`  Colosseo          (--cl): ${slots.CL.map((s) => s.time).join(' ') || 'none'}`);
  console.log('  (Colosseo entry must be at least 1h after Carcere Mamertino)\n');
  if (!CM_TIME || !CL_TIME) { console.log('• no times given: nothing was reserved'); return; }

  const cm = slots.CM.find((s) => s.time === CM_TIME);
  const cl = slots.CL.find((s) => s.time === CL_TIME);
  if (!cm || !cl) throw new Error('chosen time not available');
  if (mins(CL_TIME) - mins(CM_TIME) < 60) throw new Error('Colosseo must be at least 1h after Carcere Mamertino');

  // Hold: reserve each area
  // The reply lists the whole cart, so `have` (codes held before this call) is left out.
  const hold = async (area, slot, have = []) => {
    await http('POST', `${BASE}/${LOC}/vouchers/reserve`, {
      headers: xhrHeaders(csrf), form: { area, buy_products: products[area], multibook: 'multitickets' },
    });
    const r = await http('POST', `${BASE}/${LOC}/vouchers/create_or_update`, {
      headers: xhrHeaders(csrf),
      form: { utf8: '✓', authenticity_token: csrf, buy_area: area, buy_group_type_code: '',
        buy_reservation_date: dmy(DATE), buy_group_name: slot.id,
        buy_products: products[area], multibook: 'multitickets' },
    });
    let j; try { j = JSON.parse(r.text); } catch { j = {}; }
    const codes = reservationCodes(j.html).filter((c) => !have.includes(c));
    return { ok: r.status === 200 && codes.length > 0 && j.hold !== 'ko', codes, url: j.url };
  };

  const h1 = await hold('CM', cm);
  if (!h1.ok) throw new Error('Carcere Mamertino hold failed');
  console.log(`• held CM ${CM_TIME}: ${h1.codes.join(', ')}`);

  const h2 = await hold('CL', cl, h1.codes);
  if (!h2.ok) {
    await http('POST', `${BASE}/${LOC}/vouchers/delete_reservations`, {
      headers: xhrHeaders(csrf), form: { utf8: '✓', authenticity_token: csrf, reservations: h1.codes.join('**'), buy_area: 'CM' },
    });
    throw new Error('Colosseo hold failed: CM hold was released');
  }
  console.log(`• held CL ${CL_TIME}: ${h2.codes.join(', ')}`);

  // Open browser at checkout
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ locale: 'it-IT', userAgent: 'Mozilla/5.0', viewport: null });
  await ctx.addCookies(Object.entries(client.jar).map(([name, value]) => ({ name, value, domain: 'www.omniavaticanrome.org', path: '/', secure: true })));
  const page = await ctx.newPage();
  await page.goto(`${BASE}${h2.url || `/${LOC}/vouchers/checkout`}`);
  console.log('\n✔ Checkout open. Fill in your details and pay. Close the browser when done.');
  console.log('  The site drops unpaid holds after ~15 minutes.');
  browser.on('disconnected', () => process.exit(0));
})().catch((e) => { console.error(`✖ ${e.message}`); process.exit(1); });
