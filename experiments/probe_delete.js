// What does delete_reservations answer? Holds 1 CL + 1 CM ticket, then releases them the
// way sniper.js does (all codes sent for each area) and prints status and timing,
// then repeats the calls on the now-empty cart.
const { makeClient, dmy, BASE, LOC, AREAS } = require('../lib/client');
const { openSession, getSlots, xhrHeaders, reservationCodes } = require('../lib/site');

const [date = '2026-10-07', clTime = '11:00', cmTime = '10:00'] = process.argv.slice(2);

(async () => {
  const c = makeClient(null);
  const { csrf } = await openSession(c, { adults: 1 });
  const post = (path, form) => c.http('POST', `${BASE}/${LOC}${path}`, { headers: xhrHeaders(csrf), form });
  const add = async (area, time) => {
    const slot = (await getSlots(c, csrf, area, date, 0)).find((s) => s.time === time);
    const r = await post('/vouchers/create_or_update', {
      buy_area: area, buy_reservation_date: dmy(date), buy_group_name: slot.id,
      buy_products: `${AREAS[area].code}_1`, multibook: 'multitickets',
    });
    return reservationCodes(JSON.parse(r.text).html);
  };
  await add('CL', clTime);
  const codes = await add('CM', cmTime);
  console.log('cart codes:', codes);
  const del = async (label, area, list) => {
    const t0 = Date.now();
    const r = await post('/vouchers/delete_reservations', { reservations: list.join('**'), buy_area: area });
    let left = '?';
    try { left = reservationCodes(JSON.parse(r.text).html).join(',') || 'none'; } catch {}
    console.log(`${label}: HTTP ${r.status} in ${Date.now() - t0}ms, ${r.text.length}B, codes still in reply: ${left}`);
  };
  await del('CL area, both codes ', 'CL', codes);
  await del('CM area, both codes ', 'CM', codes);
  await del('CL area again       ', 'CL', codes);
  await del('CM area again       ', 'CM', codes);
  console.log('cart after:', (await c.http('GET', `${BASE}/${LOC}/vouchers/checkout`)).status);
  c.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
