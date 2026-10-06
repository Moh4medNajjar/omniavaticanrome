// Slot watcher: monitors for available slots on the Carcer Tullianum + Colosseo card.
// When slots appear, holds pairs and sends Telegram messages with Release/Checkout buttons.
//
// Without proxies: 1 pair per unique CL slot (anti-hoarding: max 1 hold per slot per IP).
// With proxies: each pair gets its own IP — multiple pairs on the SAME slot survive.
//
// Usage:
//   node --env-file=.env slot_watch.js                        monitor, hold on detection
//   node --env-file=.env slot_watch.js --once                 single check only
//   node --env-file=.env slot_watch.js --date 2026-10-07      watch a single date
//   node --env-file=.env slot_watch.js --days 30              scan next 30 days (default)
//   node --env-file=.env slot_watch.js --pairs 3              hold max 3 pairs per date (default: all)
//   node --env-file=.env slot_watch.js --proxies proxies.txt  use proxy list
//
// Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, PATH_PROXIES, PROXY, INTERVAL_SEC.

const fs = require('fs');
const path = require('path');
const { makeClient, arg, stamp, sleep, mins, BASE, LOC, AREAS } = require('./lib/client');
const { openSession, getExcludedDays, getSlots, openDates, holdPair, releasePair, isHoldAlive } = require('./lib/site');
const { tg, resolveChat, drainUpdates } = require('./lib/telegram');
const { loadProxies, getProxyForIndex, validateProxies } = require('./lib/proxy');

const LOG_FILE = path.join(__dirname, 'slot_watch.log');
const ONCE = process.argv.includes('--once');
const WATCH_DATE = arg('date');
const SCAN_DAYS = Math.max(1, Number(arg('days', 30)));
const MAX_PAIRS = arg('pairs') ? Math.max(1, Number(arg('pairs'))) : Infinity;
const INTERVAL_SEC = Math.max(10, Number(process.env.INTERVAL_SEC || 30));
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const log = (m) => fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${m}\n`);
const PROXIES = loadProxies();
const USE_PROXIES = PROXIES.length > 0;

let tgChat;
const tgSend = (method, body) => tg(TOKEN, method, body);

// ---------- build combos for a date ----------
function buildCombos(cmSlots, clSlots) {
  if (USE_PROXIES) {
    const combos = [];
    for (const cl of clSlots) {
      const cm = cmSlots.find((s) => mins(cl.time) - mins(s.time) >= 60) || cmSlots[0];
      combos.push({ cmSlot: cm, clSlot: cl });
    }
    if (clSlots.length < PROXIES.length && clSlots.length > 0) {
      const bestCL = clSlots[0];
      while (combos.length < PROXIES.length && combos.length < cmSlots.length * clSlots.length) {
        const cm = cmSlots.find((s) => mins(bestCL.time) - mins(s.time) >= 60) || cmSlots[0];
        combos.push({ cmSlot: cm, clSlot: bestCL });
      }
    }
    return combos;
  }
  const combos = [];
  const usedCM = new Set();
  for (const cl of clSlots) {
    let cm = cmSlots.find((s) => !usedCM.has(s.time) && mins(cl.time) - mins(s.time) >= 60);
    if (!cm) cm = cmSlots.find((s) => !usedCM.has(s.time));
    if (!cm) break;
    usedCM.add(cm.time);
    combos.push({ cmSlot: cm, clSlot: cl });
  }
  return combos;
}

// ---------- scan: find combos across all dates ----------
async function findAllSlots() {
  const scout = makeClient(USE_PROXIES ? getProxyForIndex(PROXIES, 0) : null);
  let csrf;
  try {
    ({ csrf } = await openSession(scout));
  } catch (e) { scout.close(); throw e; }

  let datesToCheck = [];
  if (WATCH_DATE) {
    datesToCheck.push(WATCH_DATE);
  } else {
    const exCM = await getExcludedDays(scout, csrf, 'CM');
    await sleep(500);
    const exCL = await getExcludedDays(scout, csrf, 'CL');
    const openCM = new Set(openDates(exCM, SCAN_DAYS));
    const openCL = new Set(openDates(exCL, SCAN_DAYS));
    for (const d of openCM) if (openCL.has(d)) datesToCheck.push(d);
  }

  if (!datesToCheck.length) { scout.close(); return []; }

  const results = [];
  for (const date of datesToCheck) {
    await sleep(500);
    const cmSlots = await getSlots(scout, csrf, 'CM', date);
    await sleep(500);
    const clSlots = await getSlots(scout, csrf, 'CL', date);
    if (!cmSlots.length || !clSlots.length) continue;
    const combos = buildCombos(cmSlots, clSlots);
    if (combos.length) results.push({ date, combos });
  }

  scout.close();
  return results;
}

// ---------- telegram hold & wait (all dates) ----------
async function telegramHoldAndWait(allPairs) {
  const live = [];
  let globalIdx = 0;

  for (const { date, pairs } of allPairs) {
    // Send a date header
    await tgSend('sendMessage', { chat_id: tgChat,
      text: `📅 ${date} — ${pairs.length} pair(s) held` });

    for (let i = 0; i < pairs.length; i++) {
      const p = pairs[i];
      const idx = globalIdx++;
      const proxyTag = p.proxyUrl ? `\n🌐 Proxy` : '';
      const text =
        `🎟️ #${idx + 1} held\n` +
        `📅 ${date}\n⛪ CM ${p.cmSlot.time}\n🏛️ CL ${p.clSlot.time}\n⏱️ ~15 min TTL${proxyTag}`;
      const msg = await tgSend('sendMessage', {
        chat_id: tgChat, text,
        reply_markup: { inline_keyboard: [
          [{ text: '🛒 Checkout', callback_data: `open_${idx}` }],
          [{ text: '❌ Release', callback_data: `release_${idx}` }],
        ] },
      });
      live.push({ pair: p, date, msgId: msg.result?.message_id, index: idx, released: false });
    }
  }

  const totalPairs = live.length;

  // TTL checker
  let ttlRunning = true;
  const ttlChecker = (async () => {
    await sleep(60000);
    while (ttlRunning && live.some((l) => !l.released)) {
      for (const entry of live) {
        if (entry.released || !ttlRunning) continue;
        try {
          if (!(await isHoldAlive(entry.pair))) {
            entry.released = true;
            const remaining = live.filter((l) => !l.released).length;
            console.log(`${stamp()} ⏰ #${entry.index + 1} (${entry.date}) dropped by site`);
            log(`PAIR ${entry.index + 1} TTL EXPIRED ${entry.date}`);
            tgSend('editMessageText', {
              chat_id: tgChat, message_id: entry.msgId,
              text: `⏰ #${entry.index + 1} — dropped by site\n` +
                `📅 ${entry.date}\n⛪ CM ${entry.pair.cmSlot.time}\n🏛️ CL ${entry.pair.clSlot.time}\n` +
                `${remaining ? `⏳ ${remaining}/${totalPairs} still held` : '🔄 All gone — resuming monitor'}`,
            }).catch(() => {});
            entry.pair.client.close();
          }
        } catch {}
        await sleep(1000);
      }
      if (live.some((l) => !l.released)) await sleep(30000);
    }
  })();

  // Button listener
  let offset = await drainUpdates(TOKEN);
  while (live.some((l) => !l.released)) {
    const j = await tgSend('getUpdates', { timeout: 25, offset, allowed_updates: ['callback_query'] }).catch(() => ({}));
    for (const u of (j.result || [])) {
      offset = u.update_id + 1;
      const q = u.callback_query;
      if (!q) continue;

      const releaseMatch = q.data?.match(/^release_(\d+)$/);
      const openMatch = q.data?.match(/^open_(\d+)$/);

      if (releaseMatch) {
        const idx = Number(releaseMatch[1]);
        const entry = live.find((l) => l.index === idx && !l.released);
        if (!entry) continue;
        await tgSend('answerCallbackQuery', { callback_query_id: q.id, text: 'Releasing…' }).catch(() => {});
        const ok = await releasePair(entry.pair);
        entry.released = true;
        const remaining = live.filter((l) => !l.released).length;
        console.log(`${stamp()} ${ok ? '✅' : '⚠️'} #${idx + 1} (${entry.date}) released`);
        log(`PAIR ${idx + 1} ${ok ? 'RELEASED' : 'RELEASE FAILED'} ${entry.date}`);
        tgSend('editMessageText', {
          chat_id: tgChat, message_id: entry.msgId,
          text: `${ok ? '✅' : '⚠️'} #${idx + 1} — released\n` +
            `📅 ${entry.date}\n⛪ CM ${entry.pair.cmSlot.time}\n🏛️ CL ${entry.pair.clSlot.time}\n` +
            `${remaining ? `⏳ ${remaining}/${totalPairs} still held` : '🔄 All released — resuming monitor'}`,
        }).catch(() => {});
      }

      if (openMatch) {
        const idx = Number(openMatch[1]);
        const entry = live.find((l) => l.index === idx && !l.released);
        if (!entry) continue;
        await tgSend('answerCallbackQuery', { callback_query_id: q.id, text: 'Opening…' }).catch(() => {});
        try {
          const { chromium } = require('playwright');
          const browser = await chromium.launch({ headless: false });
          const ctx = await browser.newContext({ locale: 'it-IT', userAgent: 'Mozilla/5.0', viewport: null });
          await ctx.addCookies(Object.entries(entry.pair.client.jar).map(([name, value]) => ({ name, value, domain: 'www.omniavaticanrome.org', path: '/', secure: true })));
          const page = await ctx.newPage();
          await page.goto(BASE + (entry.pair.checkoutUrl || `/${LOC}/vouchers/checkout`));
          entry.pair._browser = browser;
          console.log(`${stamp()} 🌐 Checkout opened for #${idx + 1}`);
        } catch (e) { console.log(`${stamp()} browser error: ${e.message}`); }
      }
    }
  }

  ttlRunning = false;
  for (const { pairs } of allPairs)
    for (const p of pairs) if (p._browser) await p._browser.close().catch(() => {});
}

// ---------- Ctrl+C handler ----------
const activePairs = [];
async function cleanup() {
  console.log(`\n${stamp()} Ctrl+C — releasing ${activePairs.length} pair(s)…`);
  for (const p of activePairs) await releasePair(p).catch(() => {});
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, cleanup);

// ---------- main loop ----------
(async () => {
  if (!TOKEN) { console.error('Set TELEGRAM_BOT_TOKEN in .env'); process.exit(1); }
  await tgSend('getMe', {});
  tgChat = await resolveChat(TOKEN, process.env.TELEGRAM_CHAT_ID);

  if (USE_PROXIES) {
    const working = await validateProxies(PROXIES);
    PROXIES.length = 0;
    PROXIES.push(...working);
  }

  const pairsLabel = MAX_PAIRS === Infinity ? 'all' : `max ${MAX_PAIRS}/date`;
  const rangeLabel = WATCH_DATE || `next ${SCAN_DAYS} days`;
  const modeLabel = USE_PROXIES
    ? `🌐 Proxy mode: ${PROXIES.length} proxies`
    : '🔒 Direct mode: 1 pair per unique CL slot';
  console.log(`${stamp()} 👁️ Slot watcher started`);
  console.log(`  Interval: ${INTERVAL_SEC}s | Pairs: ${pairsLabel}`);
  console.log(`  ${modeLabel}`);
  console.log(`  Range: ${rangeLabel}`);
  console.log(`  Telegram: ${tgChat}\n`);
  log(`start interval=${INTERVAL_SEC}s pairs=${pairsLabel} range=${rangeLabel} proxies=${PROXIES.length}`);

  await tgSend('sendMessage', { chat_id: tgChat, text:
    `👁️ Slot watcher started\n📅 ${rangeLabel}\n🔄 Every ${INTERVAL_SEC}s\n` +
    `🎟️ ${pairsLabel} pairs\n${USE_PROXIES ? `🌐 ${PROXIES.length} proxies` : '🔒 Direct (1 per slot)'}` });

  let consecutiveErrors = 0;

  for (;;) {
    try {
      console.log(`${stamp()} 🔍 Scanning ${rangeLabel}…`);
      const allDates = await findAllSlots();

      if (!allDates.length) {
        console.log(`${stamp()} No slots found. Retrying in ${INTERVAL_SEC}s.`);
      } else {
        let totalCombos = 0;
        for (const d of allDates) totalCombos += d.combos.length;
        console.log(`${stamp()} ✨ ${allDates.length} dates, ${totalCombos} total combos`);

        const allHeld = [];
        let pairNum = 0;

        for (const { date, combos } of allDates) {
          const toHold = combos.slice(0, MAX_PAIRS);
          console.log(`${stamp()} 📅 ${date}: ${toHold.length} pairs`);
          log(`FOUND ${date} combos=${combos.length} holding=${toHold.length}`);

          const pairs = [];
          for (const { cmSlot, clSlot } of toHold) {
            const proxyUrl = getProxyForIndex(PROXIES, pairNum);
            const pair = await holdPair(date, cmSlot, clSlot, proxyUrl);
            if (pair) {
              pairs.push(pair);
              activePairs.push(pair);
              pairNum++;
              const tag = proxyUrl ? ` [proxy ${(pairNum % PROXIES.length) + 1}]` : '';
              console.log(`  ✔ #${pairNum}: CM ${cmSlot.time} + CL ${clSlot.time}${tag}`);
              log(`HOLD #${pairNum} ${date} CM=${cmSlot.time}:${pair.cmCodes.join(',')} CL=${clSlot.time}:${pair.clCodes.join(',')}${tag}`);
            } else {
              console.log(`  ✖ CM ${cmSlot.time} + CL ${clSlot.time} failed`);
              log(`HOLD FAILED ${date} CM=${cmSlot.time} CL=${clSlot.time}`);
            }
            await sleep(300);
          }

          if (pairs.length) allHeld.push({ date, pairs });
        }

        const totalHeld = allHeld.reduce((n, d) => n + d.pairs.length, 0);
        if (totalHeld) {
          console.log(`${stamp()} 🎟️ ${totalHeld} pair(s) held across ${allHeld.length} date(s)`);
          await telegramHoldAndWait(allHeld);
          for (const { pairs } of allHeld)
            for (const p of pairs) { const idx = activePairs.indexOf(p); if (idx >= 0) activePairs.splice(idx, 1); }
          console.log(`${stamp()} 🔄 All pairs done. Resuming monitor.`);
        } else {
          await tgSend('sendMessage', { chat_id: tgChat, text: `⚠️ Slots found but all holds failed. Retrying…` });
        }
      }
      consecutiveErrors = 0;
    } catch (e) {
      consecutiveErrors++;
      console.log(`${stamp()} ❌ Error (${consecutiveErrors}): ${e.message}`);
      log(`ERROR (${consecutiveErrors}) ${e.message}`);
      if (consecutiveErrors === 5) {
        await tgSend('sendMessage', { chat_id: tgChat, text: `⚠️ 5 consecutive errors:\n${e.message}` }).catch(() => {});
      }
    }

    if (ONCE) { console.log(`${stamp()} --once done.`); break; }
    const wait = INTERVAL_SEC * 1000 * Math.min(2 ** Math.max(0, consecutiveErrors - 1), 8) + Math.random() * 5000;
    await sleep(wait);
  }
})().catch((e) => { console.error(`✖ ${e.message}`); process.exit(1); });
