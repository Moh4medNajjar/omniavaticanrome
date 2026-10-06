// Leapfrog on a cart made of TWO batches (1 + 1 tickets, as after stacking): book one new
// batch of 2, release the four old reservations, remove the 2 old people with delete_item.
// Question: does delete_item remove the old unbooked lines, or the new booked one?
const { makeClient, dmy, BASE, LOC, AREAS, CARD_ID } = require('../lib/client');
const { openSession, getSlots, xhrHeaders } = require('../lib/site');

const [date = '2026-10-15', clTime = '14:30'] = process.argv.slice(2);
const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

(async () => {
  const c = makeClient(null);
  const { csrf } = await openSession(c, { adults: 1 });
  const cl = (await getSlots(c, csrf, 'CL', date, 0)).find((s) => s.time === clTime);
  const cm = (await getSlots(c, csrf, 'CM', date, 7)).filter((s) => s.time < clTime).pop();
  const post = (path, form, xhr = true) => c.http('POST', `${BASE}/${LOC}${path}`, xhr ? { headers: xhrHeaders(csrf), form } : { form });
  const shoot = (area, slot, q) => post('/vouchers/create_or_update', { buy_area: area, buy_reservation_date: dmy(date), buy_group_name: slot.id, buy_products: `${AREAS[area].code}_${q}`, multibook: 'multitickets' });
  const setPax = (n) => post('/cards/set_pax', { utf8: '✓', authenticity_token: csrf, card: CARD_ID, locale: LOC, max_limit: 7, min_limit: 0, adult: n, child: 0, student: 0, newborn: 0, commit: 'Acquista' }, false);
  const del = (codes) => Promise.all(['CL', 'CM'].map((area) => post('/vouchers/delete_reservations', { reservations: codes.join('**'), buy_area: area })));
  const cart = async (label) => {
    const r = await c.http('GET', `${BASE}/${LOC}/vouchers/checkout`);
    const codes = [...new Set(r.text.match(/\bRS[A-Z]{2}\d{6,}[A-Z]\b/g) || [])];
    console.log(`${label}: ${r.status} | ${(strip(r.text).match(/\d+\s+persona\/e/) || ['-'])[0]} | ${codes.length} codes ${codes.join(',')} | ${(strip(r.text).match(/Totale:\s*[\d.,]+/) || [''])[0]}`);
    return codes;
  };
  try {
    await shoot('CL', cl, 1); await shoot('CM', cm, 1);
    await setPax(1); await shoot('CL', cl, 1); await shoot('CM', cm, 1);
    const old = await cart('two batches of 1      ');
    await setPax(2); await shoot('CL', cl, 2); await shoot('CM', cm, 2);
    const all = await cart('plus new batch of 2   ');
    const fresh = all.filter((x) => !old.includes(x));
    await del(old);
    await cart('old released          ');
    const di = await post('/vouchers/delete_item', { utf8: '✓', authenticity_token: csrf, code: '40.04.23', qta: 2 }, false);
    const end = await cart(`after delete_item qta=2 (${di.status})`);
    console.log('KEPT THE NEW BATCH:', end.length === fresh.length && fresh.every((x) => end.includes(x)), '| new codes', fresh.join(','));
  } finally {
    const left = await cart('before cleanup        ');
    if (left.length) await del(left);
    await cart('after cleanup         ');
    c.close();
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
