// Does calling create_or_update again in the same session extend the 15-min hold?
// Holds 1 CL ticket, re-sends the same request at minute 10, checks the cart at 16 and 21.
const { makeClient, sleep, dmy, BASE, LOC, AREAS } = require('../lib/client');
const { openSession, getSlots, xhrHeaders } = require('../lib/site');

const stamp = () => new Date().toTimeString().slice(0, 8);
const DATE = process.argv[2];

(async () => {
  const c = makeClient(null);
  const { csrf } = await openSession(c, { adults: 1 });
  const slots = await getSlots(c, csrf, 'CL', DATE, 1);
  const slot = slots[slots.length - 1];
  const hold = async () => {
    const r = await c.http('POST', `${BASE}/${LOC}/vouchers/create_or_update`, {
      headers: xhrHeaders(csrf),
      form: { buy_area: 'CL', buy_reservation_date: dmy(DATE), buy_group_name: slot.id,
        buy_products: `${AREAS.CL.code}_1`, multibook: 'multitickets' },
    });
    return [...new Set((JSON.parse(r.text).html || '').match(/RS[A-Z]{2}\d+[A-Z]/g) || [])];
  };
  const alive = async () => (await c.http('GET', `${BASE}/${LOC}/vouchers/checkout`)).status;
  const codes = await hold();
  console.log(`${stamp()} held ${DATE} ${slot.time}: ${codes}`);
  await sleep(10 * 60e3);
  console.log(`${stamp()} t+10 re-send: ${await hold()} cart=${await alive()}`);
  await sleep(6 * 60e3);
  console.log(`${stamp()} t+16 cart=${await alive()}  (200 = refresh worked)`);
  await sleep(5 * 60e3);
  console.log(`${stamp()} t+21 cart=${await alive()}`);
  await c.http('POST', `${BASE}/${LOC}/vouchers/delete_reservations`, {
    headers: xhrHeaders(csrf), form: { reservations: codes.join('**'), buy_area: 'CL' },
  }).catch(() => {});
  console.log(`${stamp()} released`);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
