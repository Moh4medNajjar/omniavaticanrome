// Do seats ever come back on a day? Every 20s asks which Colosseo times have a free seat
// (one request per day) and prints every change, for MINUTES minutes. Books nothing.
//   node probe_watch.js 40 2026-10-06 2026-10-07 2026-10-08
const { makeClient, sleep } = require('../lib/client');
const { openSession, getSlots } = require('../lib/site');

const [minutes = '40', ...dates] = process.argv.slice(2);
const ts = () => new Date().toTimeString().slice(0, 8);

(async () => {
  let c = makeClient(null);
  let { csrf } = await openSession(c, { adults: 1 });
  const last = {};
  const changes = {};
  const end = Date.now() + Number(minutes) * 60e3;
  while (Date.now() < end) {
    for (const d of dates) {
      let open;
      try { open = (await getSlots(c, csrf, 'CL', d, 1)).map((s) => s.time); } catch {
        c.close(); c = makeClient(null); ({ csrf } = await openSession(c, { adults: 1 })); continue;
      }
      if (!last[d]) { console.log(`${ts()} ${d} start: free seat at ${open.join(' ') || 'none'}`); last[d] = open; changes[d] = 0; continue; }
      const gained = open.filter((t) => !last[d].includes(t));
      const lost = last[d].filter((t) => !open.includes(t));
      if (gained.length || lost.length) {
        changes[d]++;
        console.log(`${ts()} ${d}:${gained.length ? ` + seat appeared at ${gained.join(' ')}` : ''}${lost.length ? ` - no seat left at ${lost.join(' ')}` : ''}`);
      }
      last[d] = open;
    }
    await sleep(20000);
  }
  console.log(`${ts()} done after ${minutes} min. Changes per day: ${JSON.stringify(changes)}`);
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
