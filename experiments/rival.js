// A rival for re-hold tests: hammers one slot back to back for MINUTES, asking for QTY
// seats. Mode "release" frees every seat it catches at once and counts it (each catch is
// a re-hold the bot would have lost). Mode "keep" holds what it catches for KEEP_S seconds
// first, to simulate a buyer taking part of the seats.
//   node rival.js 2026-10-11 15:30 10 release
const { makeClient, sleep, dmy, BASE, LOC, AREAS } = require('../lib/client');
const { openSession, getSlots, xhrHeaders, reservationCodes } = require('../lib/site');

const [date, time, minutes = '10', mode = 'release'] = process.argv.slice(2);
const QTY = Number(process.env.QTY || 1);
const KEEP_S = Number(process.env.KEEP_S || 40);
const ts = () => new Date().toTimeString().slice(0, 8);

(async () => {
  let s = makeClient(null);
  let { csrf } = await openSession(s, { adults: QTY });
  const slot = (await getSlots(s, csrf, 'CL', date, 0)).find((x) => x.time === time);
  const end = Date.now() + Number(minutes) * 60e3;
  let tries = 0;
  let stolen = 0;
  console.log(`${ts()} RIVAL: hammering ${date} ${time} for ${QTY} seat(s), mode ${mode}`);
  while (Date.now() < end) {
    let codes = [];
    try {
      const r = await s.http('POST', `${BASE}/${LOC}/vouchers/create_or_update`, {
        headers: xhrHeaders(csrf),
        form: { buy_area: 'CL', buy_reservation_date: dmy(date), buy_group_name: slot.id, buy_products: `${AREAS.CL.code}_${QTY}`, multibook: 'multitickets' },
      });
      tries++;
      codes = reservationCodes(JSON.parse(r.text).html);
    } catch { await sleep(500); continue; }
    if (!codes.length) continue;
    stolen++;
    console.log(`${ts()} RIVAL: !!! caught ${QTY} seat(s) (${codes}) after ${tries} tries${mode === 'keep' ? `, keeping ${KEEP_S}s` : ' — releasing'}`);
    if (mode === 'keep') await sleep(KEEP_S * 1000);
    for (const area of ['CL', 'CM']) {
      await s.http('POST', `${BASE}/${LOC}/vouchers/delete_reservations`, { headers: xhrHeaders(csrf), form: { reservations: codes.join('**'), buy_area: area } }).catch(() => {});
    }
    s.close();
    s = makeClient(null);
    ({ csrf } = await openSession(s, { adults: QTY }));
  }
  console.log(`${ts()} RIVAL: done, ${tries} tries, caught the seats ${stolen} time(s)`);
  process.exit(0);
})().catch((e) => { console.error('RIVAL FATAL', e.message); process.exit(1); });
