// Does the site slow down under our own parallel requests, and is that per IP or for everyone?
//   node probe_concurrency.js observe   one sequential request loop, prints latency every 4s
//   node probe_concurrency.js load      phases of 1, 3 and 6 parallel loops, prints latency per phase
// VIA_PROXY=1 gives every session its own proxy IP; otherwise all use this machine's IP.
// Run "observe" from one IP while "load" runs from another to tell the two cases apart.
// Targets a full slot, and frees the seats at once if a request happens to catch some.
const { makeClient, sleep, dmy, BASE, LOC, AREAS } = require('../lib/client');
const { openSession, getSlots, xhrHeaders } = require('../lib/site');
const { withStickySession } = require('../lib/proxy');

const [mode, date = '2026-10-07', time = '12:00'] = process.argv.slice(2);
const VIA_PROXY = process.env.VIA_PROXY === '1';
const QTY = 7;
const ts = () => new Date().toISOString().slice(11, 23);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

async function session() {
  const c = makeClient(VIA_PROXY ? withStickySession(process.env.PROXY) : null);
  const { csrf } = await openSession(c, { adults: QTY });
  return { c, csrf };
}

async function shot(s, slot) {
  const t0 = Date.now();
  const r = await s.c.http('POST', `${BASE}/${LOC}/vouchers/create_or_update`, {
    headers: xhrHeaders(s.csrf),
    form: {
      buy_area: 'CL', buy_reservation_date: dmy(date), buy_group_name: slot.id,
      buy_products: `${AREAS.CL.code}_${QTY}`, multibook: 'multitickets',
    },
  });
  const ms = Date.now() - t0;
  let codes = [];
  try { codes = [...new Set((JSON.parse(r.text).html || '').match(/RS[A-Z]{2}\d+[A-Z]/g) || [])]; } catch {}
  if (codes.length) {
    for (const area of ['CL', 'CM']) {
      await s.c.http('POST', `${BASE}/${LOC}/vouchers/delete_reservations`, {
        headers: xhrHeaders(s.csrf), form: { reservations: codes.join('**'), buy_area: area },
      }).catch(() => {});
    }
    console.log(`${ts()} caught and released ${codes}`);
  }
  return ms;
}

(async () => {
  const first = await session();
  const slot = (await getSlots(first.c, first.csrf, 'CL', date, 0)).find((s) => s.time === time);
  if (!slot) throw new Error('slot not found');
  const tag = VIA_PROXY ? 'proxy IP' : 'own IP';

  if (mode === 'observe') {
    const end = Date.now() + Number(process.env.SECS || 60) * 1000;
    let bucket = [];
    let bucketStart = Date.now();
    while (Date.now() < end) {
      const ms = await shot(first, slot).catch(() => -1);
      bucket.push(ms);
      if (ms < 0) await sleep(500);
      if (Date.now() - bucketStart >= 4000) {
        console.log(`${ts()} observer (${tag}): ${bucket.length} req, median ${med(bucket)}ms, max ${Math.max(...bucket)}ms`);
        bucket = [];
        bucketStart = Date.now();
      }
    }
  } else {
    const sessions = [first];
    while (sessions.length < 6) sessions.push(await session());
    console.log(`${ts()} load: 6 sessions ready (${VIA_PROXY ? 'one proxy IP each' : 'all from this IP'})`);
    for (const n of [1, 3, 6, 0]) {
      console.log(`${ts()} load phase: ${n} parallel`);
      if (!n) { await sleep(8000); continue; }
      const lat = [];
      const end = Date.now() + 12000;
      await Promise.all(sessions.slice(0, n).map(async (s) => {
        while (Date.now() < end) {
          const ms = await shot(s, slot).catch(() => -1);
          if (ms < 0) await sleep(500); else lat.push(ms);
        }
      }));
      console.log(`${ts()}   ${n} parallel: ${lat.length} req = ${(lat.length / 12).toFixed(1)}/s, median ${med(lat)}ms, max ${Math.max(...lat)}ms`);
    }
  }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
