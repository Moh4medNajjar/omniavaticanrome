// Why did "release, then book again in the same session" fail in the bot? On a slot with
// exactly ONE free seat:
//  1. book it; try a leapfrog (must fail, no spare seat); REMOVE the pending line;
//     release; book again at once  -> expected to work (clean in-place renewal)
//  2. same, but KEEP the pending line (two unbooked lines) -> the suspected failure;
//     then poll from a fresh session to see how long the seat stays unavailable.
const { makeClient, sleep, dmy, BASE, LOC, AREAS, CARD_ID } = require('../lib/client');
const { openSession, getSlots, xhrHeaders, reservationCodes } = require('../lib/site');

const [date = '2026-10-08', clTime = '15:00'] = process.argv.slice(2);
const ts = () => new Date().toTimeString().slice(0, 8);
const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

(async () => {
  const c = makeClient(null);
  const { csrf } = await openSession(c, { adults: 1 });
  const cl = (await getSlots(c, csrf, 'CL', date, 0)).find((s) => s.time === clTime);
  const cm = (await getSlots(c, csrf, 'CM', date, 7)).filter((s) => s.time < clTime).pop();
  const free = async () => { let n = 0; for (let p = 1; p <= 3; p++) { if ((await getSlots(c, csrf, 'CL', date, p)).some((s) => s.time === clTime)) n = p; else break; } return n; };
  console.log(`${ts()} slot ${date} ${clTime}: ${await free()} free seat(s) before the test`);
  const post = (path, form, xhr = true) => c.http('POST', `${BASE}/${LOC}${path}`, xhr ? { headers: xhrHeaders(csrf), form } : { form });
  const shoot = (area, slot) => post('/vouchers/create_or_update', { buy_area: area, buy_reservation_date: dmy(date), buy_group_name: slot.id, buy_products: `${AREAS[area].code}_1`, multibook: 'multitickets' });
  const setPax = () => post('/cards/set_pax', { utf8: '✓', authenticity_token: csrf, card: CARD_ID, locale: LOC, max_limit: 7, min_limit: 0, adult: 1, child: 0, student: 0, newborn: 0, commit: 'Acquista' }, false);
  const delItem = (q) => post('/vouchers/delete_item', { utf8: '✓', authenticity_token: csrf, code: '40.04.23', qta: q }, false);
  const del = (codes) => Promise.all(['CL', 'CM'].map((area) => post('/vouchers/delete_reservations', { reservations: codes.join('**'), buy_area: area })));
  const cart = async (label) => {
    const r = await c.http('GET', `${BASE}/${LOC}/vouchers/checkout`);
    const codes = [...new Set(r.text.match(/\bRS[A-Z]{2}\d{6,}[A-Z]\b/g) || [])];
    console.log(`${ts()}   ${label}: cart ${r.status} | ${(strip(r.text).match(/\d+\s+persona\/e/) || ['-'])[0]} | codes ${codes.join(',') || '-'}`);
    return codes;
  };
  let codes = [];
  try {
    await shoot('CL', cl); await shoot('CM', cm);
    codes = await cart('booked the only seat');

    console.log(`${ts()} 1. clean in-place: failed leapfrog, pending line removed, release, re-book`);
    await setPax(); await shoot('CL', cl);
    const lf = await cart('after leapfrog attempt (2 people expected, same codes)');
    console.log(`${ts()}   leapfrog booked something new: ${lf.some((x) => !codes.includes(x))}`);
    await delItem(1);
    await cart('pending line removed');
    let t0 = Date.now();
    await del(codes);
    const r1 = await shoot('CL', cl);
    console.log(`${ts()}   re-book ${Date.now() - t0}ms after starting the release, reply codes: ${reservationCodes(JSON.parse(r1.text).html).join(',') || 'NONE'}`);
    await shoot('CM', cm);
    const after1 = await cart('after clean in-place');
    console.log(`${ts()}   RESULT 1: ${after1.length === 2 && !after1.some((x) => codes.includes(x)) ? 'WORKS' : 'FAILED'}`);
    codes = after1;
    if (codes.length !== 2) return;

    console.log(`${ts()} 2. same but the pending line is KEPT (two unbooked lines)`);
    await setPax(); await shoot('CL', cl);
    t0 = Date.now();
    await del(codes);
    const r2 = await shoot('CL', cl);
    const got2 = reservationCodes(JSON.parse(r2.text).html);
    console.log(`${ts()}   re-book ${Date.now() - t0}ms after the release, reply codes: ${got2.join(',') || 'NONE'}`);
    const after2 = await cart('after in-place with a pending line');
    console.log(`${ts()}   RESULT 2: ${after2.length ? 'booked' : 'NOT booked'}`);
    codes = after2;
    if (!after2.length) {
      const f = makeClient(null);
      const s = await openSession(f, { adults: 1 });
      for (let i = 0; i < 25; i++) {
        const r = await f.http('POST', `${BASE}/${LOC}/vouchers/create_or_update`, { headers: xhrHeaders(s.csrf), form: { buy_area: 'CL', buy_reservation_date: dmy(date), buy_group_name: cl.id, buy_products: `${AREAS.CL.code}_1`, multibook: 'multitickets' } });
        const got = reservationCodes(JSON.parse(r.text).html);
        if (got.length) {
          console.log(`${ts()}   a fresh session could book the seat ${Math.round((Date.now() - t0) / 1000)}s after the release - releasing it`);
          for (const area of ['CL', 'CM']) await f.http('POST', `${BASE}/${LOC}/vouchers/delete_reservations`, { headers: xhrHeaders(s.csrf), form: { reservations: got.join('**'), buy_area: area } });
          break;
        }
        await sleep(1500);
      }
      f.close();
    }
  } finally {
    const left = await cart('before cleanup');
    if (left.length) await del(left);
    await sleep(1000);
    console.log(`${ts()} slot has ${await free()} free seat(s) after the test`);
    c.close();
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
