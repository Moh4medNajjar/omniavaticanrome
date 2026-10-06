// Is someone holding seats on a full slot without paying? An unpaid hold dies after 15
// minutes, so whoever keeps one must let it go and take it again. This asks for ONE seat
// on a full slot, back to back, for MINUTES (more than one 15-minute cycle). Every seat
// that shows up is logged and released at once.
//   node probe_cycle.js 2026-10-07 12:00 17
const { makeClient, sleep, dmy, BASE, LOC, AREAS } = require('../lib/client');
const { openSession, getSlots, xhrHeaders, reservationCodes } = require('../lib/site');

const [date, time, minutes = '17'] = process.argv.slice(2);
const ts = () => new Date().toTimeString().slice(0, 8);

(async () => {
  let c = makeClient(null);
  let { csrf } = await openSession(c, { adults: 1 });
  const slot = (await getSlots(c, csrf, 'CL', date, 0)).find((s) => s.time === time);
  if (!slot) throw new Error('slot not found');
  console.log(`${ts()} watching ${date} ${time} for ${minutes} min, asking for 1 seat each time`);
  const end = Date.now() + Number(minutes) * 60e3;
  let tries = 0, caught = 0, errors = 0;
  while (Date.now() < end) {
    try {
      const r = await c.http('POST', `${BASE}/${LOC}/vouchers/create_or_update`, {
        headers: xhrHeaders(csrf),
        form: { buy_area: 'CL', buy_reservation_date: dmy(date), buy_group_name: slot.id, buy_products: `${AREAS.CL.code}_1`, multibook: 'multitickets' },
      });
      tries++;
      const codes = reservationCodes(JSON.parse(r.text).html);
      if (codes.length) {
        caught++;
        console.log(`${ts()} SEAT APPEARED after ${tries} tries (${codes}) - releasing it`);
        for (const area of ['CL', 'CM']) await c.http('POST', `${BASE}/${LOC}/vouchers/delete_reservations`, { headers: xhrHeaders(csrf), form: { reservations: codes.join('**'), buy_area: area } }).catch(() => {});
        c.close(); c = makeClient(null); ({ csrf } = await openSession(c, { adults: 1 }));
        await sleep(5000);
      }
    } catch { errors++; await sleep(1000); }
    if (tries % 200 === 0) console.log(`${ts()} ${tries} tries, ${caught} seats seen, ${errors} errors`);
  }
  console.log(`${ts()} DONE: ${tries} tries in ${minutes} min, seats seen: ${caught}, errors: ${errors}`);
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
