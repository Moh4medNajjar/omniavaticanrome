// Probe for the 7-ticket sniper: slot visibility, hidden slots, quantity holds.
// Holds at most 2 tickets briefly and releases them.
const { makeClient, sleep, dmy, BASE, LOC, AREAS } = require('../lib/client');
const { openSession, getExcludedDays, xhrHeaders } = require('../lib/site');
const { withStickySession } = require('../lib/proxy');

const P = process.env.PROXY;
const fresh = () => makeClient(P ? withStickySession(P) : null);
const iso = (d) => d.toISOString().slice(0, 10);

async function avail(c, csrf, area, date, pax, extra = {}) {
  const r = await c.http('POST', `${BASE}/${LOC}/cards/get_availability`, {
    headers: xhrHeaders(csrf),
    form: { area, data: dmy(date), groups: 'IND', layout: 'horizontal', number_of_pax: pax, ...extra },
  });
  const slots = [...r.text.matchAll(/id='(GRP_(\d+)_IND_[\d-]+_(\d\d:\d\d))'/g)].map((m) => `${m[3]}=${m[2]}`);
  return { status: r.status, len: r.text.length, slots, text: r.text };
}

async function cou(c, csrf, area, date, slotId, qty) {
  const r = await c.http('POST', `${BASE}/${LOC}/vouchers/create_or_update`, {
    headers: xhrHeaders(csrf),
    form: { buy_area: area, buy_reservation_date: dmy(date), buy_group_name: slotId,
      buy_products: `${AREAS[area].code}_${qty}`, multibook: 'multitickets' },
  });
  let j = {};
  try { j = JSON.parse(r.text); } catch {}
  const codes = [...new Set((j.html || '').match(/RS[A-Z]{2}\d+[A-Z]/g) || [])];
  const msg = (j.html || r.text).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  return { status: r.status, bytes: r.text.length, codes, keys: Object.keys(j), hold: j.hold, url: j.url, msg };
}

async function del(c, csrf, codes) {
  for (const area of ['CM', 'CL']) {
    await c.http('POST', `${BASE}/${LOC}/vouchers/delete_reservations`, {
      headers: xhrHeaders(csrf), form: { reservations: codes.join('**'), buy_area: area },
    }).catch(() => {});
  }
}

(async () => {
  const c = fresh();
  const { csrf } = await openSession(c, { adults: 1 });
  const exCL = await getExcludedDays(c, csrf, 'CL');
  const exCM = await getExcludedDays(c, csrf, 'CM');
  const now = new Date();
  const days = [];
  for (let i = 0; i < 45; i++) { const d = new Date(now); d.setDate(d.getDate() + i); days.push(iso(d)); }
  console.log('== P1 calendar (next 45d): CL-excluded / CM-excluded');
  console.log('CL ex:', days.filter((d) => exCL.has(d)).join(' '));
  console.log('CM ex:', days.filter((d) => exCM.has(d)).join(' '));

  const openDay = days.find((d, i) => i >= 3 && !exCL.has(d) && !exCM.has(d));
  const exDay = days.find((d, i) => i >= 1 && exCL.has(d));
  console.log('\n== P2 slot visibility by pax on', openDay);
  for (const area of ['CL', 'CM']) {
    for (const pax of [1, 7]) {
      const a = await avail(c, csrf, area, openDay, pax);
      console.log(`${area} pax${pax}: ${a.slots.length} slots ${a.slots.join(' ')}`);
    }
  }
  const a1 = await avail(c, csrf, 'CL', openDay, 1);
  console.log('CL raw html classes:', [...new Set([...a1.text.matchAll(/class='([^']+)'/g)].map((m) => m[1]))].join(' | '));
  for (const extra of [{ number_of_pax: 0 }, { layout: 'vertical' }, { groups: '' }]) {
    const a = await avail(c, csrf, 'CL', openDay, 1, extra);
    console.log(`CL variant ${JSON.stringify(extra)}: status ${a.status}, ${a.slots.length} slots`);
  }

  console.log('\n== P3 excluded day', exDay);
  if (exDay) {
    const a = await avail(c, csrf, 'CL', exDay, 1);
    console.log(`CL on excluded day: status ${a.status}, ${a.slots.length} slots, len ${a.len}, text: ${a.text.replace(/<[^>]+>/g, ' ').trim().slice(0, 120)}`);
  }

  console.log('\n== P4 day-to-day id stride (CL first slot + every slot offset)');
  for (const d of days.filter((x) => !exCL.has(x)).slice(2, 7)) {
    const a = await avail(c, csrf, 'CL', d, 1);
    console.log(d, a.slots.join(' '));
    await sleep(200);
  }

  // Quantity hold: a CL slot that fits 2 but not 7 if possible, else any.
  const cl1 = await avail(c, csrf, 'CL', openDay, 1);
  const cl2 = await avail(c, csrf, 'CL', openDay, 2);
  const cl7 = await avail(c, csrf, 'CL', openDay, 7);
  const t2 = cl2.slots.map((s) => s.split('=')[0]);
  const t7 = cl7.slots.map((s) => s.split('=')[0]);
  const idOf = (time) => { const s = cl1.slots.find((x) => x.startsWith(time)); return `GRP_${s.split('=')[1]}_IND_${openDay}_${time}`; };
  const short = t2.find((t) => !t7.includes(t));
  console.log('\n== P5 quantity holds on', openDay, '| slot fitting 2 but not 7:', short || 'none');

  const h = fresh();
  const { csrf: hc } = await openSession(h, { adults: 2 });
  const target = t2[0];
  const r2 = await cou(h, hc, 'CL', openDay, idOf(target), 2);
  console.log(`CL qty2 @${target}: codes ${r2.codes.join(',') || '-'} bytes ${r2.bytes} keys ${r2.keys} url ${r2.url}`);
  const again = await cou(h, hc, 'CL', openDay, idOf(target), 2);
  console.log(`same session, same slot again: codes ${again.codes.join(',') || '-'} | ${again.msg.slice(0, 160)}`);
  const chk = await h.http('GET', `${BASE}/${LOC}/vouchers/checkout`);
  const lines = chk.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  console.log(`checkout ${chk.status}: ${(lines.match(/.{0,80}Colosseo.{0,120}/) || [''])[0]}`);
  await del(h, hc, [...new Set([...r2.codes, ...again.codes])]);
  h.close();

  if (short) {
    const s = fresh();
    const { csrf: sc } = await openSession(s, { adults: 7 });
    const r7 = await cou(s, sc, 'CL', openDay, idOf(short), 7);
    console.log(`\nqty7 on slot with <7 seats @${short}: codes ${r7.codes.join(',') || '-'} hold ${r7.hold} | ${r7.msg.slice(0, 200)}`);
    if (r7.codes.length) await del(s, sc, r7.codes);
    s.close();
  }

  const f = fresh();
  const { csrf: fc } = await openSession(f, { adults: 1 });
  const fake = await cou(f, fc, 'CL', openDay, `GRP_1_IND_${openDay}_23:59`, 1);
  console.log(`\nfake slot id: status ${fake.status} codes ${fake.codes.join(',') || '-'} hold ${fake.hold} | ${fake.msg.slice(0, 200)}`);
  if (fake.codes.length) await del(f, fc, fake.codes);
  f.close();
  c.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
