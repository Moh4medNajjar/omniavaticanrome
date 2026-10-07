// Handoff re-hold: the holder releases the Colosseo seat while pre-opened sessions fire
// their booking shots at fixed offsets after the release is SENT, without waiting for its
// reply. Repeats ROUNDS times on a slot with exactly one free seat (the winner becomes the
// next holder) and prints which offset won. A "watcher" session hammers the same slot the
// whole time, playing a competitor; if it ever wins, the gap was long enough to lose.
const { makeClient, sleep, dmy, BASE, LOC, AREAS } = require('../lib/client');
const { openSession, getSlots, xhrHeaders, reservationCodes } = require('../lib/site');

const [date = '2026-10-09', time = '17:15', rounds = '6'] = process.argv.slice(2);
const STREAMS = Number(process.env.STREAMS || 4);
const ts = () => new Date().toISOString().slice(11, 23);

async function session() {
  const c = makeClient(null);
  const { csrf } = await openSession(c, { adults: 1 });
  return { c, csrf };
}

(async () => {
  let holder = await session();
  const slot = (await getSlots(holder.c, holder.csrf, 'CL', date, 0)).find((s) => s.time === time);
  const free = async () => (await getSlots(holder.c, holder.csrf, 'CL', date, 1)).some((s) => s.time === time);
  if (!(await free())) throw new Error('slot has no free seat');
  const book = (s) => s.c.http('POST', `${BASE}/${LOC}/vouchers/create_or_update`, {
    headers: xhrHeaders(s.csrf),
    form: { buy_area: 'CL', buy_reservation_date: dmy(date), buy_group_name: slot.id, buy_products: `${AREAS.CL.code}_1`, multibook: 'multitickets' },
  }).then((r) => reservationCodes(JSON.parse(r.text).html), () => []);
  const release = (s, codes) => s.c.http('POST', `${BASE}/${LOC}/vouchers/delete_reservations`, {
    headers: xhrHeaders(s.csrf), form: { reservations: codes.join('**'), buy_area: 'CL' },
  });

  let held = await book(holder);
  console.log(`${ts()} holder took the seat: ${held}`);

  // The competitor: hammers the slot back to back for the whole test.
  let stop = false;
  let stolen = 0;
  const watcher = await session();
  const watching = (async () => {
    while (!stop) {
      const got = await book(watcher);
      if (got.length) { stolen++; console.log(`${ts()} !!! WATCHER STOLE THE SEAT (${got}) — releasing`); await release(watcher, got); }
    }
  })();

  for (let r = 1; r <= Number(rounds); r++) {
    const shooters = [];
    for (let i = 0; i < STREAMS; i++) shooters.push(await session());
    await sleep(500);
    const t0 = Date.now();
    const rel = release(holder, held).then(() => Date.now() - t0);
    let winner = null;
    const log = [];
    await Promise.all(shooters.map((s, i) => sleep(i * 100).then(async () => {
      while (!winner && Date.now() - t0 < 8000) {
        const sent = Date.now() - t0;
        const codes = await book(s);
        log.push(`${i}:${sent}→${Date.now() - t0}${codes.length ? '✓' : ''}`);
        if (codes.length) {
          if (winner) await release(s, codes); else winner = { i, codes, at: Date.now() - t0, sent };
        }
      }
    })));
    const relMs = await rel;
    console.log(`${ts()} round ${r}: release answered at ${relMs}ms | ${winner ? `WON by stream ${winner.i}, shot sent at ${winner.sent}ms, confirmed at ${winner.at}ms` : 'LOST'} | ${log.length} shots`);
    holder.c.close();
    shooters.filter((s, i) => !winner || winner.i !== i).forEach((s) => s.c.close());
    if (!winner) break;
    const won = [winner];
    holder = shooters[won[0].i];
    held = won[0].codes;
    await sleep(2000);
  }
  stop = true;
  await watching;
  if (held.length) await release(holder, held);
  console.log(`${ts()} done. watcher stole the seat ${stolen} time(s)`);
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
