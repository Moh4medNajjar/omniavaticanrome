// How does a reservation code appear in the create_or_update reply? Holds 1 ticket for a
// moment, prints the markup around the code and every other code-like match, then releases.
const { makeClient, dmy, BASE, LOC, AREAS } = require('../lib/client');
const { openSession, getSlots, xhrHeaders } = require('../lib/site');

const [date = '2026-10-07', time = '11:00'] = process.argv.slice(2);
const LOOSE = /RS[A-Z]{2}\d+[A-Z]/g;

(async () => {
  const c = makeClient(null);
  const { csrf } = await openSession(c, { adults: 1 });
  const slot = (await getSlots(c, csrf, 'CL', date, 0)).find((s) => s.time === time);
  const post = (path, form) => c.http('POST', `${BASE}/${LOC}${path}`, { headers: xhrHeaders(csrf), form });
  const r = await post('/vouchers/create_or_update', {
    buy_area: 'CL', buy_reservation_date: dmy(date), buy_group_name: slot.id,
    buy_products: `${AREAS.CL.code}_1`, multibook: 'multitickets',
  });
  const html = JSON.parse(r.text).html;
  const codes = [...new Set(html.match(LOOSE) || [])];
  console.log('loose matches:', codes);
  for (const m of html.matchAll(LOOSE)) {
    console.log(`  @${m.index}: …${html.slice(Math.max(0, m.index - 90), m.index + m[0].length + 60).replace(/\s+/g, ' ')}…`);
  }
  console.log('\nbase64-like tokens in the block:', (html.match(/[A-Za-z0-9+/]{40,}={0,2}/g) || []).map((t) => t.length));
  console.log('inputs:', [...html.matchAll(/<input[^>]*name="([^"]+)"[^>]*>/g)].map((m) => m[1]).join(', '));
  if (codes.length) {
    for (const area of ['CL', 'CM']) await post('/vouchers/delete_reservations', { reservations: codes.join('**'), buy_area: area }).catch(() => {});
    console.log('released');
  }
  // Same question for a "full" reply: what can look like a code there?
  const s7 = makeClient(null);
  const { csrf: c7 } = await openSession(s7, { adults: 7 });
  const full = await s7.http('POST', `${BASE}/${LOC}/vouchers/create_or_update`, {
    headers: xhrHeaders(c7),
    form: { buy_area: 'CL', buy_reservation_date: dmy(date), buy_group_name: slot.id.replace(time, '12:00'), buy_products: `${AREAS.CL.code}_7`, multibook: 'multitickets' },
  });
  const fh = JSON.parse(full.text).html;
  console.log('\n"full" reply: length', fh.length, '| base64-like tokens:', (fh.match(/[A-Za-z0-9+/]{40,}={0,2}/g) || []).map((t) => t.length),
    '| contains delete_reservation form:', /delete_reservation/.test(fh));
  c.close(); s7.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
