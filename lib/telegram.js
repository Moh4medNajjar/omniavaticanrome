// Telegram bot helpers.

const { stamp } = require('./client');

async function tg(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    // Longer than the 25s long poll, short enough that a dead connection is noticed.
    signal: AbortSignal.timeout(40000),
  });
  return res.json().catch(() => ({}));
}

async function resolveChat(token, chatId) {
  if (chatId) return chatId;
  console.log(`${stamp()} Telegram: send /start to your bot to begin…`);
  const deadline = Date.now() + 120000;
  for (let offset = 0; Date.now() < deadline;) {
    const j = await tg(token, 'getUpdates', { timeout: 20, offset }).catch(() => ({}));
    for (const u of (j.result || [])) {
      offset = u.update_id + 1;
      if (u.message?.chat?.id) {
        console.log(`${stamp()} Telegram: chat ${u.message.chat.id}`);
        return u.message.chat.id;
      }
    }
  }
  throw new Error('No Telegram message received in 2 minutes');
}

async function drainUpdates(token) {
  let offset = 0;
  for (;;) {
    const j = await tg(token, 'getUpdates', { timeout: 0, offset }).catch(() => ({}));
    if (!j.result?.length) break;
    offset = j.result[j.result.length - 1].update_id + 1;
  }
  return offset;
}

module.exports = { tg, resolveChat, drainUpdates };
