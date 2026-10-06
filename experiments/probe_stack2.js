// Stacking details. In one session: book 1 ticket, change the party size with a single
// set_pax (no card page), then shoot a FULL slot and a FREE slot and compare the replies,
// to learn how a later batch's success can be recognised. Also times get_availability.
// Releases everything it finds on the cart page at the end.
const { makeClient, dmy, BASE, LOC, AREAS, CARD_ID } = require('../lib/client');
const { openSession, xhrHeaders, reservationCodes } = require('../lib/site');

const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

(async () => {
  const c = makeClient(null);
  let { csrf } = await openSession(c, { adults: 1 });
  const avail = async (area, date, pax) => {
    const t0 = Date.now();
    const r = await c.http('POST', `${BASE}/${LOC}/cards/get_availability`, {
      headers: xhrHeaders(csrf), form: { area, data: dmy(date), groups: 'IND', layout: 'horizontal', number_of_pax: pax },
    });
    return { ms: Date.now() - t0, status: r.status, slots: [...r.text.matchAll(/id='(GRP_\d+_IND_[\d-]+_(\d\d:\d\d))'/g)].map((m) => ({ id: m[1], time: m[2] })) };
  };
  // find a day with a CL slot that has 2+ seats and a full CL slot
  let date, free, full;
  for (const d of ['2026-10-07', '2026-10-08', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14']) {
    const two = (await avail('CL', d, 2)).slots;
    const all = (await avail('CL', d, 0)).slots;
    const one = (await avail('CL', d, 1)).slots.map((s) => s.time);
    const f = all.find((s) => !one.includes(s.time));
    if (two.length && f) { date = d; free = two[two.length - 1]; full = f; break; }
  }
  if (!date) throw new Error('no suitable day');
  console.log(`day ${date}: free slot ${free.time}, full slot ${full.time}`);
  const cm = (await avail('CM', date, 0)).slots.find((s) => s.time < free.time && Number(free.time.slice(0, 2)) - Number(s.time.slice(0, 2)) >= 1);

  const shoot = async (area, slot, qty) => {
    const t0 = Date.now();
    const r = await c.http('POST', `${BASE}/${LOC}/vouchers/create_or_update`, {
      headers: xhrHeaders(csrf),
      form: { buy_area: area, buy_reservation_date: dmy(date), buy_group_name: slot.id, buy_products: `${AREAS[area].code}_${qty}`, multibook: 'multitickets' },
    });
    let j = {};
    try { j = JSON.parse(r.text); } catch {}
    return { status: r.status, ms: Date.now() - t0, html: j.html || '', url: j.url, codes: reservationCodes(j.html) };
  };
  const cart = async () => {
    const r = await c.http('GET', `${BASE}/${LOC}/vouchers/checkout`);
    const t = strip(r.text);
    return { status: r.status, people: (t.match(/\d+\s+persona\/e/g) || []).join(' + '), codes: [...new Set(r.text.match(/\bRS[A-Z]{2}\d{6,}[A-Z]\b/g) || [])], total: (t.match(/Totale:\s*[\d.,]+/) || [''])[0] };
  };

  try {
    const a = await shoot('CL', free, 1);
    const b = await shoot('CM', cm, 1);
    console.log(`batch 1: CL codes ${a.codes} | CM codes ${b.codes} | url ${b.url}`);
    console.log('cart:', JSON.stringify(await cart()));

    // change party size with ONE request, reusing the csrf token
    const sp = await c.http('POST', `${BASE}/${LOC}/cards/set_pax`, {
      form: { utf8: '✓', authenticity_token: csrf, card: CARD_ID, locale: LOC, max_limit: 7, min_limit: 0, adult: 1, child: 0, student: 0, newborn: 0, commit: 'Acquista' },
    });
    console.log(`set_pax with csrf only: HTTP ${sp.status} -> ${sp.location}`);

    const f = await shoot('CL', full, 1);
    console.log(`\nshot at FULL slot : HTTP ${f.status} ${f.ms}ms, html ${f.html.length}B, codes ${f.codes.join(',') || 'none'}, url ${f.url}`);
    const s = await shoot('CL', free, 1);
    console.log(`shot at FREE slot : HTTP ${s.status} ${s.ms}ms, html ${s.html.length}B, codes ${s.codes.join(',') || 'none'}, url ${s.url}`);
    const tf = strip(f.html), ts = strip(s.html);
    console.log('text FULL:', tf.slice(0, 400));
    console.log('text FREE:', ts.slice(0, 400));
    console.log('reservations inputs FULL:', (f.html.match(/name="reservations"[^>]*>/g) || []).length, '| FREE:', (s.html.match(/name="reservations"[^>]*>/g) || []).length);
    console.log('forms FULL:', (f.html.match(/<form[^>]*action="[^"]*"/g) || []).map((x) => x.split('action=')[1]).join(' '));
    console.log('forms FREE:', (s.html.match(/<form[^>]*action="[^"]*"/g) || []).map((x) => x.split('action=')[1]).join(' '));
    console.log('cart after CL of batch 2:', JSON.stringify(await cart()));
    const s2 = await shoot('CM', cm, 1);
    console.log(`CM of batch 2: codes ${s2.codes.join(',') || 'none'} url ${s2.url}`);
    console.log('cart after CM of batch 2:', JSON.stringify(await cart()));

    const times = [];
    for (let i = 0; i < 5; i++) times.push((await avail('CL', date, 1)).ms);
    console.log('\nget_availability pax=1 latency ms:', times.join(', '));
  } finally {
    const left = (await cart()).codes;
    for (const area of ['CL', 'CM']) {
      await c.http('POST', `${BASE}/${LOC}/vouchers/delete_reservations`, { headers: xhrHeaders(csrf), form: { reservations: left.join('**'), buy_area: area } }).catch(() => {});
    }
    console.log('after release:', JSON.stringify(await cart()));
    c.close();
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
