// Can a cart grow in place? Hold 1, then ask for 2, then ask for 7 (too many) in the same session.
// Holds at most 2 tickets for a few seconds and releases them.
const { makeClient, sleep, dmy, BASE, LOC, AREAS } = require('../lib/client');
const { openSession, xhrHeaders } = require('../lib/site');

async function slots(c, csrf, date, pax) {
  const r = await c.http('POST', `${BASE}/${LOC}/cards/get_availability`, {
    headers: xhrHeaders(csrf),
    form: { area: 'CL', data: dmy(date), groups: 'IND', layout: 'horizontal', number_of_pax: pax },
  });
  return [...r.text.matchAll(/id='(GRP_\d+_IND_[\d-]+_(\d\d:\d\d))'/g)].map((m) => ({ id: m[1], time: m[2] }));
}

async function seats(c, csrf, date, time) {
  let n = 0;
  for (let p = 1; p <= 7; p++) {
    if ((await slots(c, csrf, date, p)).some((s) => s.time === time)) n = p; else break;
  }
  return n;
}

async function cou(c, csrf, date, id, qty) {
  const t0 = Date.now();
  const r = await c.http('POST', `${BASE}/${LOC}/vouchers/create_or_update`, {
    headers: xhrHeaders(csrf),
    form: { buy_area: 'CL', buy_reservation_date: dmy(date), buy_group_name: id,
      buy_products: `${AREAS.CL.code}_${qty}`, multibook: 'multitickets' },
  });
  let j = {};
  try { j = JSON.parse(r.text); } catch {}
  return { codes: [...new Set((j.html || '').match(/RS[A-Z]{2}\d+[A-Z]/g) || [])], ms: Date.now() - t0, bytes: r.text.length };
}

async function cart(c) {
  const r = await c.http('GET', `${BASE}/${LOC}/vouchers/checkout`);
  if (r.status !== 200) return `cart ${r.status}`;
  const t = r.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  return (t.match(/Colosseo[^€]{0,60}?(\d+) persona/) || [0, '?'])[1] + ' person(s) in cart';
}

(async () => {
  const scout = makeClient(null);
  const { csrf: sc } = await openSession(scout, { adults: 1 });
  let pick;
  const d0 = new Date();
  for (let i = 2; i < 20 && !pick; i++) {
    const d = new Date(d0); d.setDate(d.getDate() + i);
    const date = d.toISOString().slice(0, 10);
    const s2 = await slots(scout, sc, date, 2);
    const s7 = (await slots(scout, sc, date, 7)).map((s) => s.time);
    const s = s2.find((x) => !s7.includes(x.time));
    if (s) pick = { date, ...s };
  }
  if (!pick) { console.log('no slot with 2..6 seats found'); return; }
  console.log(`slot ${pick.date} ${pick.time}: ${await seats(scout, sc, pick.date, pick.time)} seats free`);

  const a = makeClient(null);
  const { csrf } = await openSession(a, { adults: 7 });
  const all = new Set();
  const step = async (label, qty) => {
    const r = await cou(a, csrf, pick.date, pick.id, qty);
    r.codes.forEach((c) => all.add(c));
    console.log(`${label}: codes [${r.codes}] ${r.ms}ms ${r.bytes}B | ${await cart(a)} | free for others: ${await seats(scout, sc, pick.date, pick.time)}`);
  };
  try {
    await step('ask 1 (session pax 7)', 1);
    await step('ask 2 same session   ', 2);
    await step('ask 7 (too many)     ', 7);
    await step('ask 1 again (shrink) ', 1);
  } finally {
    for (const area of ['CL', 'CM']) {
      await a.http('POST', `${BASE}/${LOC}/vouchers/delete_reservations`, {
        headers: xhrHeaders(csrf), form: { reservations: [...all].join('**'), buy_area: area },
      }).catch(() => {});
    }
    await sleep(500);
    console.log(`released | ${await cart(a)} | free: ${await seats(scout, sc, pick.date, pick.time)}`);
    a.close(); scout.close();
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
