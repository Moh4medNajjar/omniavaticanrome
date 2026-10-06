// Live seats-remaining monitor. READ-ONLY: never reserves or holds anything.
// Counts seats per slot by probing pax 7,6,…,1 and seeing when the slot disappears.
//
//   node --env-file=.env seats.js                                    first bookable day, first slot
//   node --env-file=.env seats.js --date 2026-11-20                  that date
//   node --env-file=.env seats.js --date 2026-11-20 --cm 10:30 --cl 12:00
//   node --env-file=.env seats.js --interval 5 --count 20
// Optional env: TELEGRAM_BOT_TOKEN (+ TELEGRAM_CHAT_ID).

const fs = require('fs');
const path = require('path');
const { makeClient, arg, stamp, sleep, dmy, BASE, LOC, AREAS } = require('./lib/client');
const { openSession, getExcludedDays, getSlots } = require('./lib/site');
const { tg, resolveChat } = require('./lib/telegram');

const LOG_FILE = path.join(__dirname, 'seats.log');
const INTERVAL = Math.max(1, Number(arg('interval', 5)));
const COUNT = Number(arg('count', 0));
const MINUTES = Number(arg('minutes', 0));
const REQ_DELAY = Math.max(0, Number(arg('req-delay', 300)));
const DATE_ARG = arg('date');
const SLOT = { CM: arg('cm'), CL: arg('cl') };
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const log = (m) => fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${m}\n`);

let client, csrf, maxPax = 7, tgChat;

async function init() {
  client = makeClient();
  const session = await openSession(client);
  csrf = session.csrf;
  maxPax = session.maxLimit;
  for (const area of Object.keys(AREAS)) {
    await getExcludedDays(client, csrf, area);
    await sleep(REQ_DELAY);
  }
}

async function seatsFor(area, date, time) {
  for (let p = maxPax; p >= 2; p--) {
    const slots = await getSlots(client, csrf, area, date, p);
    if (slots.some((s) => s.time === time)) return p >= maxPax ? `${maxPax}+` : String(p);
    await sleep(REQ_DELAY);
  }
  return '1';
}

async function chooseTargets() {
  let date = DATE_ARG;
  if (!date) {
    const exCM = new Set(); const exCL = new Set();
    // Use excluded days already loaded during init; re-fetch to get them
    const excCM = await getExcludedDays(client, csrf, 'CM');
    await sleep(REQ_DELAY);
    const excCL = await getExcludedDays(client, csrf, 'CL');
    const d = new Date(); d.setDate(d.getDate() + 42);
    for (let i = 0; i < 400; i++) {
      const iso = d.toISOString().slice(0, 10);
      if (!excCM.has(iso) && !excCL.has(iso)) { date = iso; break; }
      d.setDate(d.getDate() + 1);
    }
    if (!date) throw new Error('no day open in both areas');
  }

  const targets = {};
  for (const area of Object.keys(AREAS)) {
    const slots = await getSlots(client, csrf, area, date);
    const time = SLOT[area] || slots[0]?.time || null;
    targets[area] = { date, time, exists: time ? slots.some((s) => s.time === time) : false };
    await sleep(REQ_DELAY);
  }
  return targets;
}

function describe(seats) {
  if (seats === '—') return 'no slot tracked';
  if (seats === '0') return 'sold out';
  if (seats === `${maxPax}+`) return `at least ${maxPax} seats`;
  return `${seats} seat${seats === '1' ? '' : 's'} left`;
}

(async () => {
  await init();
  const targets = await chooseTargets();
  const date = targets.CM.date;

  for (const area of Object.keys(AREAS))
    console.log(`${AREAS[area].name}: tracking ${date} ${targets[area].time || '(no slots)'}`);
  console.log(`Updating every ${INTERVAL}s. Ctrl+C to stop.\n`);
  log(`start date=${date} cm=${targets.CM.time} cl=${targets.CL.time} interval=${INTERVAL}s`);

  if (TOKEN) {
    tgChat = await resolveChat(TOKEN, process.env.TELEGRAM_CHAT_ID);
  }

  const stopAt = MINUTES ? Date.now() + MINUTES * 60000 : 0;
  let n = 0, prev = '';

  for (;;) {
    let rows;
    try {
      rows = [];
      for (const area of Object.keys(AREAS)) {
        const t = targets[area];
        let seats = '—';
        if (t.time) {
          const slots = await getSlots(client, csrf, area, date);
          seats = slots.some((s) => s.time === t.time) ? await seatsFor(area, date, t.time) : '0';
        }
        rows.push({ area, name: AREAS[area].name, time: t.time, seats });
        await sleep(REQ_DELAY);
      }
    } catch (e) {
      console.log(`${stamp()} session lost (${e.message}); reopening…`);
      try { await init(); } catch { await sleep(INTERVAL * 1000); }
      continue;
    }

    const ts = stamp();
    const line = rows.map((r) => `${r.area} ${r.name} ${r.time || '--:--'}: ${r.seats}`).join('   |   ');
    console.log(`${ts}  ${line}`);

    if (TOKEN && tgChat) {
      const body = rows.map((r) => `• ${r.name} at ${r.time || '--:--'}: ${describe(r.seats)}`).join('\n');
      await tg(TOKEN, 'sendMessage', { chat_id: tgChat, text:
        `🎟️ Seat check — ${date}\n${body}\n⏱️ ${ts}` }).catch(() => {});
    }

    if (line !== prev) { log(line); prev = line; }
    if (COUNT && ++n >= COUNT) break;
    if (stopAt && Date.now() >= stopAt) break;
    await sleep(INTERVAL * 1000);
  }
})().catch((e) => { console.error(`✖ ${e.message}`); process.exit(1); });
