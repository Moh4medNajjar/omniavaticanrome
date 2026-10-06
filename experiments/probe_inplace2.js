// After an in-place release + re-book, what does the cart page say BETWEEN re-booking
// Colosseo and adding Carcere, and after Carcere is added? Run on a slot with exactly one
// free seat. Case 3: pending line removed first. Case 4: pending line kept.
const { makeClient, dmy, BASE, LOC, AREAS, CARD_ID } = require('../lib/client');
const { openSession, getSlots, xhrHeaders, reservationCodes } = require('../lib/site');

const [date = '2026-10-06', clTime = '15:00'] = process.argv.slice(2);
const ts = () => new Date().toTimeString().slice(0, 8);
const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

(async () => {
  const c = makeClient(null);
  const { csrf } = await openSession(c, { adults: 1 });
  const cl = (await getSlots(c, csrf, 'CL', date, 0)).find((s) => s.time === clTime);
  const cm = (await getSlots(c, csrf, 'CM', date, 7)).filter((s) => s.time < clTime).pop();
  const post = (path, form, xhr = true) => c.http('POST', `${BASE}/${LOC}${path}`, xhr ? { headers: xhrHeaders(csrf), form } : { form });
  const shoot = async (area, slot) => reservationCodes(JSON.parse((await post('/vouchers/create_or_update', { buy_area: area, buy_reservation_date: dmy(date), buy_group_name: slot.id, buy_products: `${AREAS[area].code}_1`, multibook: 'multitickets' })).text).html);
  const setPax = () => post('/cards/set_pax', { utf8: '✓', authenticity_token: csrf, card: CARD_ID, locale: LOC, max_limit: 7, min_limit: 0, adult: 1, child: 0, student: 0, newborn: 0, commit: 'Acquista' }, false);
  const delItem = (q) => post('/vouchers/delete_item', { utf8: '✓', authenticity_token: csrf, code: '40.04.23', qta: q }, false);
  const del = (codes) => Promise.all(['CL', 'CM'].map((area) => post('/vouchers/delete_reservations', { reservations: codes.join('**'), buy_area: area })));
  const cart = async (label) => {
    const r = await c.http('GET', `${BASE}/${LOC}/vouchers/checkout`);
    const codes = [...new Set(r.text.match(/\bRS[A-Z]{2}\d{6,}[A-Z]\b/g) || [])];
    console.log(`${ts()}   ${label}: cart ${r.status}${r.status === 302 ? ` -> ${r.location}` : ''} | ${(strip(r.text).match(/\d+\s+persona\/e/) || ['-'])[0]} | codes ${codes.join(',') || '-'}`);
    return codes;
  };
  let codes = [];
  try {
    await shoot('CL', cl); await shoot('CM', cm);
    codes = await cart('booked the only seat');
    for (const keepPending of [false, true]) {
      console.log(`${ts()} case ${keepPending ? '4: pending line KEPT' : '3: pending line removed'}`);
      await setPax(); await shoot('CL', cl);
      if (!keepPending) await delItem(1);
      await del(codes);
      await cart('after release, before re-booking');
      console.log(`${ts()}   Colosseo re-book reply codes: ${(await shoot('CL', cl)).join(',') || 'NONE'}`);
      await cart('BETWEEN Colosseo and Carcere');
      console.log(`${ts()}   Carcere reply codes: ${(await shoot('CM', cm)).join(',') || 'NONE'}`);
      const now = await cart('after Carcere');
      if (keepPending) { await delItem(1); await cart('after removing the leftover line'); }
      console.log(`${ts()}   RESULT: ${now.length === 2 && !now.some((x) => codes.includes(x)) ? 'OK, new pair held' : 'NOT OK'}`);
      if (now.length !== 2) break;
      codes = now;
    }
  } finally {
    const left = await cart('before cleanup');
    if (left.length) await del(left);
    await cart('after cleanup');
    c.close();
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
