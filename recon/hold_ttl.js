// Measures how long the site keeps an unpaid hold before releasing the seat.
// It holds ONE adult Colosseo ticket (card 10) in a slot that has only a few seats left, then leaves that
// session idle. A second, independent session watches how many seats the slot still offers: the count drops
// by one when the hold is placed and comes back when the site frees it. At --max-minutes the hold is
// released explicitly. Raw server responses are saved to out/hold_ttl/.
//
//   node hold_ttl.js [--max-minutes 100] [--poll-seconds 30]
const fs = require('fs');
const path = require('path');

const BASE = 'https://www.omniavaticanrome.org';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const CARD_SLUG = 'carcer-tullianum-colosseo-foro-romano-e-palatino';
const CARD_ID = 10;
const AREA = 'CL';
const PRODUCTS = '30.97.05_1'; // one adult Colosseo ticket
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const MAX_MINUTES = arg('max-minutes', 100);
const POLL_SECONDS = arg('poll-seconds', 30);
const SCAN_FROM = 7; // scan dates this many days ahead...
const SCAN_DAYS = 10; // ...for this many days
const OUT = path.join(__dirname, 'out', 'hold_ttl');
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, 'run.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (msg) => { const line = `${new Date().toISOString()} ${msg}`; console.log(line); fs.appendFileSync(LOG, line + '\n'); };
const save = (name, content) => fs.writeFileSync(path.join(OUT, name), content);

// One anonymous session opened for one adult on the card, with the Colosseo widget loaded.
async function session() {
  const jar = {};
  const http = async (method, url, { form, headers = {} } = {}) => {
    await sleep(500);
    const res = await fetch(BASE + url, { method, redirect: 'manual', body: form ? new URLSearchParams(form).toString() : undefined,
      headers: { 'User-Agent': UA, 'Accept-Language': 'it-IT,it;q=0.9', Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}), ...headers } });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); }
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  };
  const card = await http('GET', `/it/cards/${CARD_SLUG}`);
  const token = card.text.match(/name="authenticity_token" value="([^"]+)"/)?.[1];
  const pax = await http('POST', '/it/cards/set_pax', { form: { utf8: '✓', authenticity_token: token, card: CARD_ID, locale: 'it', max_limit: 7, min_limit: 0, adult: 1, child: 0, student: 0, newborn: 0, commit: 'Acquista' } });
  if (pax.status !== 302) throw new Error(`set_pax ${pax.status}`);
  const mt = await http('GET', '/it/cards/multitickets');
  const csrf = mt.text.match(/name="csrf-token" content="([^"]+)"/)?.[1];
  if (!csrf) throw new Error('no csrf token');
  const xhr = { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': csrf };
  const widget = await http('POST', '/it/vouchers/reserve', { headers: xhr, form: { area: AREA, buy_products: PRODUCTS, multibook: 'multitickets' } });
  const excluded = new Set(JSON.parse(widget.text.match(/exclude_days\s*=\s*(\[[^\]]*\])/)?.[1] || '[]'));
  // slots offered to a party of n on that day: [{ id, time }]
  const slots = async (day, n) => {
    const [Y, M, D] = day.split('-');
    const r = await http('POST', '/it/cards/get_availability', { headers: xhr, form: { area: AREA, data: `${D}-${M}-${Y}`, groups: 'IND', layout: 'horizontal', number_of_pax: n } });
    if (r.status !== 200) throw new Error(`get_availability ${r.status}`);
    return [...r.text.matchAll(/id='(GRP_\d+_IND_[\d-]+_(\d\d:\d\d))'/g)].map((m) => ({ id: m[1], time: m[2] }));
  };
  return { http, xhr, csrf, excluded, slots, jar };
}

// Seats the slot still offers, 0..7 (7 means "7 or more": the site never sells more than 7 per order).
async function remaining(obs, day, time) {
  let r = 0;
  for (let n = 1; n <= 7; n++) { if (!(await obs.slots(day, n)).some((s) => s.time === time)) break; r = n; }
  return r;
}

(async () => {
  say(`start: max ${MAX_MINUTES} min, poll every ${POLL_SECONDS}s`);
  let obs = await session();
  const watch = async (day, time) => {
    try { return await remaining(obs, day, time); } catch (e) { say(`observer error (${e.message}), reopening its session`); obs = await session(); return remaining(obs, day, time); }
  };

  // 1. Find a slot with 2..6 seats left (the more the better, later dates first on ties)
  let pick = null;
  for (let i = SCAN_FROM; i < SCAN_FROM + SCAN_DAYS; i++) {
    const d = new Date(); d.setDate(d.getDate() + i); const day = d.toISOString().slice(0, 10);
    if (obs.excluded.has(day)) continue;
    const left = {}; const ids = {};
    for (let n = 1; n <= 7; n++) { const s = await obs.slots(day, n); if (!s.length) break; for (const x of s) { left[x.time] = n; ids[x.time] = x.id; } }
    say(`scan ${day}: ${Object.entries(left).map(([t, n]) => `${t}=${n}`).join(' ') || 'no slots'}`);
    for (const [time, n] of Object.entries(left)) if (n >= 2 && n <= 6 && (!pick || n >= pick.left)) pick = { day, time, id: ids[time], left: n };
  }
  if (!pick) { say('no slot with 2..6 seats left in the scanned range: nothing was held'); return; }
  say(`chosen slot: ${pick.day} ${pick.time} (${pick.id}), ${pick.left} seats left`);

  // 2. Hold one ticket from a second session, then leave that session idle
  const holder = await session();
  const before = await watch(pick.day, pick.time);
  if (before < 2) { say(`slot changed to ${before} seats before the hold: nothing was held`); return; }
  const [Y, M, D] = pick.day.split('-');
  const r = await holder.http('POST', '/it/vouchers/create_or_update', { headers: holder.xhr,
    form: { utf8: '✓', authenticity_token: holder.csrf, buy_area: AREA, buy_group_type_code: '', buy_reservation_date: `${D}-${M}-${Y}`, buy_group_name: pick.id, buy_products: PRODUCTS, multibook: 'multitickets' } });
  const t0 = Date.now();
  save('create_or_update.response.txt', `HTTP ${r.status}\n\n${r.text}`);
  let j; try { j = JSON.parse(r.text); } catch { j = {}; }
  const codes = [...new Set((j.html || '').match(/RS[A-Z]{2}\d+[A-Z]/g) || [])];
  if (r.status !== 200 || !codes.length || j.hold === 'ko') { say(`hold failed (HTTP ${r.status}): nothing was held`); return; }
  say(`HOLD placed: ${codes.join(', ')} (seats before: ${before})`);
  // The holder's cookies, so its cart can be opened in a browser (doing so makes the session active, which may affect the timing)
  save('holder_cookies.json', JSON.stringify(holder.jar, null, 2));
  const mm = () => ((Date.now() - t0) / 60000).toFixed(1);

  const release = async (why) => {
    const d = await holder.http('POST', '/it/vouchers/delete_reservations', { headers: holder.xhr, form: { utf8: '✓', authenticity_token: holder.csrf, reservations: codes.join('**'), buy_area: AREA } });
    save('delete_reservations.response.txt', `HTTP ${d.status}\n\n${d.text}`);
    let dj; try { dj = JSON.parse(d.text); } catch { dj = null; }
    const gone = d.status === 200 && dj !== null && !codes.some((c) => (dj.html || '').includes(c));
    say(`explicit release (${why}) at ${mm()} min: HTTP ${d.status}, codes ${gone ? 'no longer listed' : 'STILL LISTED or reply unreadable'}`);
    return gone;
  };
  let finished = false;
  process.on('SIGINT', async () => { if (!finished) await release('interrupted').catch(() => {}); process.exit(0); });

  // 3. Watch the slot from outside until the seat comes back, or the time cap
  const series = [];
  let level = before - 1; // seats expected while the hold is alive
  let freedAt = null; let lastHeldAt = 0;
  const summary = { slot: pick, codes, heldAt: new Date(t0).toISOString(), seatsBefore: before, maxMinutes: MAX_MINUTES, pollSeconds: POLL_SECONDS };
  try {
    for (let poll = 1; ; poll++) {
      const left = await watch(pick.day, pick.time);
      const at = (Date.now() - t0) / 1000;
      series.push({ seconds: Math.round(at), seatsLeft: left });
      say(`+${mm()} min: ${left} seats left`);
      if (poll === 2 && series.every((s) => s.seatsLeft >= before)) { summary.outcome = 'the hold never reduced the seats the slot offers, so this method cannot see it'; break; }
      if (left < level) { say(`  seats dropped below the expected ${level}: someone else took seats; continuing from ${left}`); level = left; }
      if (left > level) {
        if (freedAt === null) { freedAt = at; say('  seat count went up: checking again to confirm'); await sleep(5000); continue; }
        summary.outcome = 'released by the site';
        summary.releasedBetweenSeconds = [Math.round(lastHeldAt), Math.round(freedAt)];
        break;
      }
      freedAt = null; lastHeldAt = at;
      if (at / 60 >= MAX_MINUTES) { summary.outcome = `still held after ${MAX_MINUTES} minutes (time cap)`; break; }
      await sleep(POLL_SECONDS * 1000);
    }
  } catch (e) {
    summary.outcome = `aborted: ${e.message}`;
    say(`error: ${e.message}`);
  } finally {
    // 4. What the holding session itself still shows, then clean up
    try {
      const co = await holder.http('GET', '/it/vouchers/checkout');
      save('checkout_after.response.html', `HTTP ${co.status} location=${co.location || ''}\n\n${co.text}`);
      summary.holderCheckout = { status: co.status, location: co.location, stillListsCodes: codes.some((c) => co.text.includes(c)) };
      say(`holder's checkout page: HTTP ${co.status}${co.location ? ' -> ' + co.location : ''}, codes ${summary.holderCheckout.stillListsCodes ? 'still listed' : 'not listed'}`);
      summary.explicitRelease = await release(summary.outcome === 'released by the site' ? 'cleanup after expiry' : 'not expired');
      summary.seatsAfter = await watch(pick.day, pick.time);
      say(`seats left after cleanup: ${summary.seatsAfter}`);
    } catch (e) { say(`cleanup error: ${e.message}`); summary.cleanupError = e.message; }
    finished = true;
    summary.series = series;
    save('summary.json', JSON.stringify(summary, null, 2));
    say(`RESULT: ${summary.outcome}${summary.releasedBetweenSeconds ? ` between ${summary.releasedBetweenSeconds[0]}s and ${summary.releasedBetweenSeconds[1]}s after the hold` : ''}`);
  }
})().catch((e) => { say(`fatal: ${e.message}`); process.exit(1); });
