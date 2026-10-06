// Two faster ways to renew a hold, both inside the SAME session (no new sessions):
//  A. "in place": release the reservations, then book again straight away.
//  B. "leapfrog": while the old tickets are still held, announce the same number again,
//     book the new batch, and only then release the old one. Needs spare seats, zero gap.
// Uses 1 ticket on a slot with 2+ free seats; prints timings and the cart after each step.
const { makeClient, dmy, BASE, LOC, AREAS, CARD_ID } = require('../lib/client');
const { openSession, getSlots, xhrHeaders, reservationCodes } = require('../lib/site');

const [date = '2026-10-09', clTime = '11:00'] = process.argv.slice(2);
const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

(async () => {
  const c = makeClient(null);
  const { csrf } = await openSession(c, { adults: 1 });
  const cl = (await getSlots(c, csrf, 'CL', date, 0)).find((s) => s.time === clTime);
  const cm = (await getSlots(c, csrf, 'CM', date, 7)).filter((s) => s.time < clTime).pop();
  const post = (path, form, xhr = true) => c.http('POST', `${BASE}/${LOC}${path}`, xhr ? { headers: xhrHeaders(csrf), form } : { form });
  const shoot = (area, slot) => post('/vouchers/create_or_update', { buy_area: area, buy_reservation_date: dmy(date), buy_group_name: slot.id, buy_products: `${AREAS[area].code}_1`, multibook: 'multitickets' });
  const del = (codes) => Promise.all(['CL', 'CM'].map((area) => post('/vouchers/delete_reservations', { reservations: codes.join('**'), buy_area: area })));
  const cart = async (label) => {
    const r = await c.http('GET', `${BASE}/${LOC}/vouchers/checkout`);
    const t = strip(r.text);
    const codes = [...new Set(r.text.match(/\bRS[A-Z]{2}\d{6,}[A-Z]\b/g) || [])];
    console.log(`  ${label}: ${r.status} | ${(t.match(/\d+\s+persona\/e/) || ['-'])[0]} | codes ${codes.join(',') || '-'} | ${(t.match(/Totale:\s*[\d.,]+/) || [''])[0]}`);
    return codes;
  };
  try {
    await shoot('CL', cl); await shoot('CM', cm);
    let codes = await cart('start');

    console.log('A. in place: release, then book again in the same session');
    let t0 = Date.now();
    await del(codes);
    const tFreed = Date.now() - t0;
    const a1 = await shoot('CL', cl);
    const tBack = Date.now() - t0;
    await shoot('CM', cm);
    console.log(`  released after ${tFreed}ms, Colosseo re-booked at ${tBack}ms (seat was free ~${tBack - tFreed}ms), all done ${Date.now() - t0}ms | reply codes: ${reservationCodes(JSON.parse(a1.text).html)}`);
    const afterA = await cart('after A');
    console.log(`  new codes: ${afterA.filter((x) => !codes.includes(x)).join(',') || 'NONE'}`);
    codes = afterA;

    console.log('B. leapfrog: book a second batch first, then drop the old one');
    t0 = Date.now();
    const sp = await post('/cards/set_pax', { utf8: '✓', authenticity_token: csrf, card: CARD_ID, locale: LOC, max_limit: 7, min_limit: 0, adult: 1, child: 0, student: 0, newborn: 0, commit: 'Acquista' }, false);
    await shoot('CL', cl); await shoot('CM', cm);
    const both = await cart(`both held (set_pax ${sp.status})`);
    const fresh = both.filter((x) => !codes.includes(x));
    await del(codes);
    const di = await post('/vouchers/delete_item', { utf8: '✓', authenticity_token: csrf, code: '40.04.23', qta: 1 }, false);
    console.log(`  whole leapfrog ${Date.now() - t0}ms (delete_item ${di.status}) | new batch codes: ${fresh.join(',') || 'NONE'}`);
    const afterB = await cart('after B');
    console.log(`  kept exactly the new batch: ${afterB.length === fresh.length && fresh.every((x) => afterB.includes(x))}`);
  } finally {
    const left = await cart('before cleanup');
    if (left.length) await del(left);
    await cart('after cleanup');
    c.close();
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
