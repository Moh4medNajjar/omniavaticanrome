// Can one cart hold two separate batches of the same card? Books 1 ticket (CL + CM),
// then goes back to the card page in the SAME session and books 1 more, the way a person
// would on the website. Prints what the checkout page shows, then releases everything.
const { makeClient, dmy, BASE, LOC, AREAS } = require('../lib/client');
const { openSession, getSlots, xhrHeaders, reservationCodes } = require('../lib/site');

const [date = '2026-10-07', clTime = '11:00', cmTime = '10:00'] = process.argv.slice(2);

(async () => {
  const c = makeClient(null);
  const all = new Set();
  let csrf;
  const cart = async (label) => {
    const r = await c.http('GET', `${BASE}/${LOC}/vouchers/checkout`);
    const t = r.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const codes = [...new Set(r.text.match(/\bRS[A-Z]{2}\d{6,}[A-Z]\b/g) || [])];
    console.log(`${label}: checkout ${r.status} | people lines: ${(t.match(/\d+\s+persona\/e/g) || []).join(' + ') || '-'} | codes: ${codes.join(', ') || '-'} | ${(t.match(/Totale:\s*[\d.,]+/) || [''])[0]}`);
  };
  const batch = async (n, qty) => {
    ({ csrf } = await openSession(c, { adults: qty }));
    for (const [area, time] of [['CL', clTime], ['CM', cmTime]]) {
      const slot = (await getSlots(c, csrf, area, date, 0)).find((s) => s.time === time);
      const r = await c.http('POST', `${BASE}/${LOC}/vouchers/create_or_update`, {
        headers: xhrHeaders(csrf),
        form: { buy_area: area, buy_reservation_date: dmy(date), buy_group_name: slot.id,
          buy_products: `${AREAS[area].code}_${qty}`, multibook: 'multitickets' },
      });
      let codes = [];
      try { codes = reservationCodes(JSON.parse(r.text).html); } catch {}
      codes.forEach((x) => all.add(x));
      console.log(`batch ${n} ${area} x${qty}: HTTP ${r.status}, codes in reply: ${codes.join(', ') || 'none'}`);
    }
    await cart(`after batch ${n}`);
  };
  try {
    await batch(1, 1);
    await batch(2, 1);
  } finally {
    for (const area of ['CL', 'CM']) {
      await c.http('POST', `${BASE}/${LOC}/vouchers/delete_reservations`, {
        headers: xhrHeaders(csrf), form: { reservations: [...all].join('**'), buy_area: area },
      }).catch(() => {});
    }
    await cart('after release');
    c.close();
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
