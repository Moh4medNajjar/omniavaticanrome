// Does a pending party size (set_pax with nothing booked yet) change what the cart
// page shows or charges? Also: does the plain text of a "full" reply stay identical
// between shots, and differ after a successful stacked shot?
const { makeClient, dmy, BASE, LOC, AREAS, CARD_ID } = require('../lib/client');
const { openSession, getSlots, xhrHeaders } = require('../lib/site');

const [date = '2026-10-08', clTime = '17:00', fullTime = '09:30'] = process.argv.slice(2);
const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

(async () => {
  const c = makeClient(null);
  const { csrf } = await openSession(c, { adults: 1 });
  const cl = await getSlots(c, csrf, 'CL', date, 0);
  const cm = await getSlots(c, csrf, 'CM', date, 0);
  const free = cl.find((s) => s.time === clTime), full = cl.find((s) => s.time === fullTime), cmSlot = cm.find((s) => s.time === '15:30') || cm[0];
  const shoot = async (area, slot, qty) => {
    const r = await c.http('POST', `${BASE}/${LOC}/vouchers/create_or_update`, {
      headers: xhrHeaders(csrf),
      form: { buy_area: area, buy_reservation_date: dmy(date), buy_group_name: slot.id, buy_products: `${AREAS[area].code}_${qty}`, multibook: 'multitickets' },
    });
    return strip(JSON.parse(r.text).html || '');
  };
  const setPax = async (n) => (await c.http('POST', `${BASE}/${LOC}/cards/set_pax`, {
    form: { utf8: '✓', authenticity_token: csrf, card: CARD_ID, locale: LOC, max_limit: 7, min_limit: 0, adult: n, child: 0, student: 0, newborn: 0, commit: 'Acquista' },
  })).status;
  const cart = async (label) => {
    const r = await c.http('GET', `${BASE}/${LOC}/vouchers/checkout`);
    const t = strip(r.text);
    const codes = [...new Set(r.text.match(/\bRS[A-Z]{2}\d{6,}[A-Z]\b/g) || [])];
    console.log(`${label}: ${r.status} | ${(t.match(/\d+\s+persona\/e/g) || []).join(' + ')} | ${codes.length} codes | ${(t.match(/Totale:\s*[\d.,]+/) || [''])[0]}`);
    return codes;
  };
  try {
    await shoot('CL', free, 1); await shoot('CM', cmSlot, 1);
    await cart('batch 1 done          ');
    console.log('set_pax(3):', await setPax(3));
    await cart('pending pax 3, nothing booked');
    const f1 = await shoot('CL', full, 3), f2 = await shoot('CL', full, 3);
    console.log('two FULL replies identical text:', f1 === f2, `(${f1.length} chars)`);
    await cart('after 2 full shots    ');
    console.log('set_pax(1):', await setPax(1));
    const g1 = await shoot('CL', full, 1);
    const ok = await shoot('CL', free, 1);
    console.log('FULL vs SUCCESS text identical:', g1 === ok, `(${g1.length} vs ${ok.length})`);
    for (let i = 0; i < Math.min(g1.length, ok.length); i++) if (g1[i] !== ok[i]) { console.log('first difference:', JSON.stringify(g1.slice(i - 60, i + 80)), '\n            vs  ', JSON.stringify(ok.slice(i - 60, i + 80))); break; }
    await cart('batch 2 CL only       ');
    await shoot('CM', cmSlot, 1);
    await cart('batch 2 done          ');
    console.log('set_pax(5):', await setPax(5));
    await cart('pending pax 5 again   ');
  } finally {
    const left = await cart('before release        ');
    for (const area of ['CL', 'CM']) await c.http('POST', `${BASE}/${LOC}/vouchers/delete_reservations`, { headers: xhrHeaders(csrf), form: { reservations: left.join('**'), buy_area: area } }).catch(() => {});
    await cart('after release         ');
    c.close();
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
