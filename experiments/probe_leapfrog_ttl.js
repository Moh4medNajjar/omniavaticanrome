// Does a leapfrogged batch get its own fresh 15 minutes? Holds 1 ticket at t0, leapfrogs
// at t0+10 min (books a second batch in the same session, releases the first), then
// reads the cart at t0+16 (alive = fresh timer), t0+21 and t0+26.5 (should be gone:
// the second batch is then older than 15 min). Releases whatever is left.
const { makeClient, sleep, dmy, BASE, LOC, AREAS, CARD_ID } = require('../lib/client');
const { openSession, getSlots, xhrHeaders } = require('../lib/site');

const [date = '2026-10-09', clTime = '11:00'] = process.argv.slice(2);
const ts = () => new Date().toTimeString().slice(0, 8);
const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

(async () => {
  const c = makeClient(null);
  const { csrf } = await openSession(c, { adults: 1 });
  const cl = (await getSlots(c, csrf, 'CL', date, 0)).find((s) => s.time === clTime);
  const cm = (await getSlots(c, csrf, 'CM', date, 7)).filter((s) => s.time < clTime).pop();
  const post = (path, form, xhr = true) => c.http('POST', `${BASE}/${LOC}${path}`, xhr ? { headers: xhrHeaders(csrf), form } : { form });
  const shoot = (area, slot) => post('/vouchers/create_or_update', { buy_area: area, buy_reservation_date: dmy(date), buy_group_name: slot.id, buy_products: `${AREAS[area].code}_1`, multibook: 'multitickets' });
  const del = (codes) => Promise.all(['CL', 'CM'].map((area) => post('/vouchers/delete_reservations', { reservations: codes.join('**'), buy_area: area })));
  const cart = async (label) => {
    const r = await c.http('GET', `${BASE}/${LOC}/vouchers/checkout`);
    const codes = [...new Set(r.text.match(/\bRS[A-Z]{2}\d{6,}[A-Z]\b/g) || [])];
    console.log(`${ts()} ${label}: cart ${r.status} | ${(strip(r.text).match(/\d+\s+persona\/e/) || ['-'])[0]} | codes ${codes.join(',') || '-'}`);
    return codes;
  };
  const t0 = Date.now();
  const at = (min) => sleep(Math.max(0, t0 + min * 60e3 - Date.now()));
  await shoot('CL', cl); await shoot('CM', cm);
  const first = await cart('t+0  first batch booked');
  await at(10);
  await post('/cards/set_pax', { utf8: '✓', authenticity_token: csrf, card: CARD_ID, locale: LOC, max_limit: 7, min_limit: 0, adult: 1, child: 0, student: 0, newborn: 0, commit: 'Acquista' }, false);
  await shoot('CL', cl); await shoot('CM', cm);
  await del(first);
  await post('/vouchers/delete_item', { utf8: '✓', authenticity_token: csrf, code: '40.04.23', qta: 1 }, false);
  const second = await cart('t+10 leapfrogged');
  console.log(`${ts()} new batch: ${second.filter((x) => !first.includes(x)).join(',') || 'NONE'}`);
  await at(16);
  const a = await cart('t+16 (first batch would be dead by now)');
  console.log(`${ts()} RESULT: ${a.length && second.every((x) => a.includes(x)) ? 'FRESH TIMER - leapfrog works' : 'NOT FRESH - cart is gone or changed'}`);
  await at(21);
  await cart('t+21');
  await at(26.5);
  const z = await cart('t+26.5 (second batch is 16.5 min old)');
  if (z.length) { await del(z); await cart('released'); }
  c.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
