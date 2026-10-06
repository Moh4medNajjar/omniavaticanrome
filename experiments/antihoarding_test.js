// Anti-hoarding experiment: tests what the site enforces when multiple sessions
// hold tickets from the same IP.
//
// 3 phases:
//   1. Control — 1 pair, verify it survives 2 min
//   2. Same slot — 2 pairs on SAME slot, verify pair 2 is dropped
//   3. Different slots — 2 pairs on different slots, verify both survive
//
// Usage: node --env-file=../.env antihoarding_test.js [--date 2026-10-05]

const fs = require('fs');
const path = require('path');
const { makeClient, arg, stamp, sleep, dmy, mins, BASE, LOC, AREAS } = require('../lib/client');
const { openSession, getExcludedDays, getSlots, holdPair, releasePair, isHoldAlive } = require('../lib/site');
const { tg } = require('../lib/telegram');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
const WATCH_DATE = arg('date');
const LOG_FILE = path.join(__dirname, 'antihoarding_test.log');
const log = (m) => { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${m}\n`); console.log(`${stamp()} ${m}`); };
const notify = async (text) => { console.log(text); if (TOKEN && CHAT) await tg(TOKEN, 'sendMessage', { chat_id: CHAT, text }).catch(() => {}); };

async function checkAliveLoop(pairs, labels, durationSec, intervalSec = 15) {
  const results = [];
  const start = Date.now();
  let checkNum = 0;
  while (Date.now() - start < durationSec * 1000) {
    await sleep(intervalSec * 1000);
    checkNum++;
    const elapsed = Math.round((Date.now() - start) / 1000);
    const statuses = [];
    for (let i = 0; i < pairs.length; i++) {
      if (!pairs[i]) { statuses.push(false); continue; }
      statuses.push(await isHoldAlive(pairs[i]));
      await sleep(500);
    }
    const line = statuses.map((a, i) => `${labels[i]}: ${a ? '✅' : '❌'}`).join('  |  ');
    log(`  Check #${checkNum} (+${elapsed}s): ${line}`);
    results.push({ elapsed, statuses });
  }
  return results;
}

async function findDate() {
  if (WATCH_DATE) return WATCH_DATE;
  const scout = makeClient();
  const { csrf } = await openSession(scout);
  const exCM = await getExcludedDays(scout, csrf, 'CM');
  await sleep(500);
  const exCL = await getExcludedDays(scout, csrf, 'CL');
  const d = new Date();
  for (let i = 0; i < 90; i++, d.setDate(d.getDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    if (!exCM.has(iso) && !exCL.has(iso)) return iso;
  }
  throw new Error('no open date found');
}

async function findSlots(date) {
  const scout = makeClient();
  const { csrf } = await openSession(scout);
  const cmSlots = await getSlots(scout, csrf, 'CM', date);
  await sleep(500);
  const clSlots = await getSlots(scout, csrf, 'CL', date);
  return { cmSlots, clSlots };
}

(async () => {
  log('=== ANTI-HOARDING EXPERIMENT ===');
  await notify('🔬 Anti-hoarding experiment starting…');

  const date = await findDate();
  log(`Using date: ${date}`);
  const { cmSlots, clSlots } = await findSlots(date);
  if (!cmSlots.length || !clSlots.length) { log('Not enough slots'); process.exit(1); }

  const cmA = cmSlots[0], clA = clSlots[0];
  const cmB = cmSlots.length > 1 ? cmSlots[1] : cmSlots[0];
  const clB = clSlots.length > 1 ? clSlots[1] : null;

  // Phase 1: Control
  log('\n━━━ PHASE 1: CONTROL ━━━');
  const p1 = await holdPair(date, cmA, clA);
  if (!p1) { log('FAILED: could not hold'); process.exit(1); }
  log(`Held: CM ${p1.cmCodes.join(',')} + CL ${p1.clCodes.join(',')}`);
  const r1 = await checkAliveLoop([p1], ['Pair1'], 120);
  const p1ok = r1.every((r) => r.statuses[0]);
  await releasePair(p1);
  await notify(`1️⃣ Control: ${p1ok ? '✅ alive 2 min' : '❌ dropped!'}`);
  await sleep(5000);

  // Phase 2: Same slot
  log('\n━━━ PHASE 2: SAME SLOT ━━━');
  const p2a = await holdPair(date, cmA, clA);
  if (!p2a) { log('FAILED'); process.exit(1); }
  await sleep(500);
  const p2b = await holdPair(date, cmA, clA);
  const r2 = await checkAliveLoop([p2a, p2b], ['First', 'Second'], 120);
  const aOk = r2.every((r) => r.statuses[0]);
  const bOk = p2b ? r2.every((r) => r.statuses[1]) : false;
  const bDrop = p2b ? r2.find((r) => !r.statuses[1])?.elapsed : null;
  await releasePair(p2a);
  if (p2b) await releasePair(p2b);
  await notify(`2️⃣ Same slot: First ${aOk ? '✅' : '❌'}, Second ${bOk ? '✅' : `❌ at ~${bDrop}s`}`);
  await sleep(5000);

  // Phase 3: Different slots
  log('\n━━━ PHASE 3: DIFFERENT SLOTS ━━━');
  if (!clB) {
    await notify('3️⃣ SKIPPED: only 1 CL slot available');
  } else {
    const p3a = await holdPair(date, cmA, clA);
    await sleep(500);
    const p3b = await holdPair(date, cmB, clB);
    const r3 = await checkAliveLoop([p3a, p3b], ['SlotA', 'SlotB'], 120);
    const aOk3 = p3a ? r3.every((r) => r.statuses[0]) : false;
    const bOk3 = p3b ? r3.every((r) => r.statuses[1]) : false;
    if (p3a) await releasePair(p3a);
    if (p3b) await releasePair(p3b);
    const verdict = aOk3 && bOk3 ? '✅ Both survived → per-slot rule' : '❌ Both dropped → per-IP rule';
    await notify(`3️⃣ Different slots: ${verdict}`);
  }

  log('=== DONE ===');
})().catch((e) => { console.error(`✖ ${e.message}`); process.exit(1); });
