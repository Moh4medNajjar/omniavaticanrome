// pax=0 visibility on closed days, for CM, and per-pax seat counts.
const { makeClient, dmy, BASE, LOC } = require('../lib/client');
const { openSession, xhrHeaders } = require('../lib/site');

async function avail(c, csrf, area, date, pax) {
  const r = await c.http('POST', `${BASE}/${LOC}/cards/get_availability`, {
    headers: xhrHeaders(csrf),
    form: { area, data: dmy(date), groups: 'IND', layout: 'horizontal', number_of_pax: pax },
  });
  return [...r.text.matchAll(/id='GRP_(\d+)_IND_[\d-]+_(\d\d:\d\d)'/g)].map((m) => m[2]);
}

(async () => {
  const c = makeClient(null);
  const { csrf } = await openSession(c, { adults: 1 });
  for (const d of ['2026-10-09', '2026-10-10', '2026-11-01', '2026-12-20', '2027-01-15']) {
    console.log(`${d} pax0 CL: ${(await avail(c, csrf, 'CL', d, 0)).length} slots, CM: ${(await avail(c, csrf, 'CM', d, 0)).length}`);
  }
  const d = '2026-10-07';
  const all = await avail(c, csrf, 'CL', d, 0);
  const seats = {};
  for (let p = 1; p <= 7; p++) for (const t of await avail(c, csrf, 'CL', d, p)) seats[t] = p;
  console.log(`\n${d} CL seats: ${all.map((t) => `${t}:${seats[t] ? (seats[t] === 7 ? '7+' : seats[t]) : 0}`).join(' ')}`);
  c.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
