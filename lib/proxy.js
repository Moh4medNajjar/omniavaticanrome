// Proxy loading, session-ID stamping, and validation.

const fs = require('fs');
const { arg } = require('./client');

function generateSessionId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function withStickySession(proxyUrl) {
  const sid = generateSessionId();
  if (/_session-[A-Za-z0-9]+/.test(proxyUrl)) {
    return proxyUrl.replace(/_session-[A-Za-z0-9]+/, `_session-${sid}`);
  }
  const at = proxyUrl.lastIndexOf('@');
  if (at > 0) return proxyUrl.slice(0, at) + `_session-${sid}` + proxyUrl.slice(at);
  return proxyUrl;
}

function loadProxies() {
  const proxyPath = arg('proxies') || process.env.PATH_PROXIES;
  if (proxyPath) {
    if (!fs.existsSync(proxyPath)) { console.error(`Proxy file not found: ${proxyPath}`); process.exit(1); }
    const lines = fs.readFileSync(proxyPath, 'utf8').split('\n')
      .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (!lines.length) { console.error('Proxy file is empty'); process.exit(1); }
    return lines;
  }
  if (process.env.PROXY) return [process.env.PROXY];
  return [];
}

function getProxyForIndex(proxies, i) {
  if (!proxies.length) return null;
  return withStickySession(proxies[i % proxies.length]);
}

async function validateProxies(proxies) {
  const { ProxyAgent } = require('undici');
  const { stamp } = require('./client');
  console.log(`${stamp()} 🔌 Validating ${proxies.length} proxy(ies)…`);
  const working = [];
  for (let i = 0; i < proxies.length; i++) {
    const url = withStickySession(proxies[i]);
    try {
      const agent = new ProxyAgent(url);
      const res = await fetch('https://httpbin.org/ip', { dispatcher: agent, signal: AbortSignal.timeout(15000) });
      const data = await res.json();
      agent.close();
      console.log(`  ✔ Proxy ${i + 1}: ${data.origin || '?'}`);
      working.push(proxies[i]);
    } catch (e) {
      console.log(`  ✖ Proxy ${i + 1}: ${e.message}`);
    }
  }
  if (!working.length) {
    console.error(`${stamp()} ❌ No working proxies. Run without --proxies for direct mode.`);
    process.exit(1);
  }
  if (working.length < proxies.length) {
    console.log(`${stamp()} ⚠️ ${working.length}/${proxies.length} proxies working`);
  }
  console.log();
  return working;
}

module.exports = { loadProxies, getProxyForIndex, withStickySession, validateProxies };
