// How to remove a pending (unbooked) batch from the cart. Books 1 ticket, adds a pending
// party of 3, prints the cart page's delete_item forms, tries delete_item, prints the cart.
const { makeClient, dmy, BASE, LOC, AREAS, CARD_ID } = require('../lib/client');
const { openSession, getSlots, xhrHeaders } = require('../lib/site');

const [date = '2026-10-08', clTime = '17:00'] = process.argv.slice(2);
const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

(async () => {
  const c = makeClient(null);
  const { csrf } = await openSession(c, { adults: 1 });
  const free = (await getSlots(c, csrf, 'CL', date, 0)).find((s) => s.time === clTime);
  const cmSlot = (await getSlots(c, csrf, 'CM', date, 0)).find((s) => s.time === '15:30');
  const shoot = (area, slot, qty) => c.http('POST', `${BASE}/${LOC}/vouchers/create_or_update`, {
    headers: xhrHeaders(csrf),
    form: { buy_area: area, buy_reservation_date: dmy(date), buy_group_name: slot.id, buy_products: `${AREAS[area].code}_${qty}`, multibook: 'multitickets' },
  });
  const setPax = (n) => c.http('POST', `${BASE}/${LOC}/cards/set_pax`, {
    form: { utf8: '✓', authenticity_token: csrf, card: CARD_ID, locale: LOC, max_limit: 7, min_limit: 0, adult: n, child: 0, student: 0, newborn: 0, commit: 'Acquista' },
  });
  let page = '';
  const cart = async (label) => {
    const r = await c.http('GET', `${BASE}/${LOC}/vouchers/checkout`);
    page = r.text;
    const t = strip(r.text);
    const codes = [...new Set(r.text.match(/\bRS[A-Z]{2}\d{6,}[A-Z]\b/g) || [])];
    console.log(`${label}: ${r.status} | ${(t.match(/\d+\s+persona\/e/g) || []).join(' + ')} | ${codes.length} codes | ${(t.match(/Totale:\s*[\d.,]+/) || [''])[0]}`);
    return codes;
  };
  const delItem = async (code, qta) => {
    const r = await c.http('POST', `${BASE}/${LOC}/vouchers/delete_item`, { form: { utf8: '✓', authenticity_token: csrf, code, qta } });
    console.log(`delete_item code=${code} qta=${qta}: HTTP ${r.status} -> ${r.location}`);
  };
  try {
    await shoot('CL', free, 1); await shoot('CM', cmSlot, 1);
    await setPax(3);
    await cart('1 booked + 3 pending ');
    for (const f of page.match(/<form[^>]*delete_item[\s\S]*?<\/form>/g) || []) {
      console.log('  form inputs:', [...f.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)].filter((m) => !/token|utf8/.test(m[1])).map((m) => `${m[1]}=${m[2]}`).join(' '),
        '| selects:', [...f.matchAll(/<select[^>]*name="([^"]+)"/g)].map((m) => m[1]).join(','),
        '| options:', [...f.matchAll(/<option[^>]*value="([^"]*)"/g)].map((m) => m[1]).join(','));
    }
    await delItem('40.04.23', 3);
    await cart('after delete qta=3   ');
    await setPax(2);
    await cart('1 booked + 2 pending ');
    await delItem('40.04.23', 2);
    const codes = await cart('after delete qta=2   ');
    // is the booked ticket still releasable / intact, and can stacking continue?
    await setPax(1);
    await shoot('CL', free, 1); await shoot('CM', cmSlot, 1);
    await cart('stacked 1 more       ');
    console.log('codes before delete tests:', codes.join(','));
  } finally {
    const left = await cart('before release       ');
    for (const area of ['CL', 'CM']) await c.http('POST', `${BASE}/${LOC}/vouchers/delete_reservations`, { headers: xhrHeaders(csrf), form: { reservations: left.join('**'), buy_area: area } }).catch(() => {});
    await cart('after release        ');
    c.close();
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
