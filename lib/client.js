// Cookie-jar HTTP client with optional proxy support.

const BASE = 'https://www.omniavaticanrome.org';
const LOC = 'it';
const CARD_SLUG = 'carcer-tullianum-colosseo-foro-romano-e-palatino';
const CARD_ID = 10;
const AREAS = { CM: { name: 'Carcere Mamertino', code: '30.97.01' }, CL: { name: 'Colosseo', code: '30.97.05' } };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

let ProxyAgent;
try { ProxyAgent = require('undici').ProxyAgent; } catch {}

function makeClient(proxyUrl) {
  const jar = {};
  let dispatcher;
  if (proxyUrl) {
    if (!ProxyAgent) throw new Error('undici required for proxy support: npm install undici');
    dispatcher = new ProxyAgent(proxyUrl);
  }

  const http = async (method, url, { form, headers = {} } = {}) => {
    const fullUrl = url.startsWith('http') ? url : BASE + url;
    const opts = {
      // Without a limit a stalled connection would hang for undici's default 5 minutes.
      method, redirect: 'manual', signal: AbortSignal.timeout(30000),
      body: form ? new URLSearchParams(form).toString() : undefined,
      headers: {
        'User-Agent': UA, 'Accept-Language': 'it-IT,it;q=0.9',
        Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}),
        ...headers,
      },
    };
    if (dispatcher) opts.dispatcher = dispatcher;
    const res = await fetch(fullUrl, opts);
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    }
    return { status: res.status, text: await res.text(), location: res.headers.get('location') || '' };
  };

  const close = () => { if (dispatcher) dispatcher.close().catch(() => {}); };

  return { http, jar, close, proxyUrl };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dmy = (iso) => { const [Y, M, D] = iso.split('-'); return `${D}-${M}-${Y}`; };
const mins = (t) => +t.slice(0, 2) * 60 + +t.slice(3);
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const stamp = () => new Date().toTimeString().slice(0, 8);

module.exports = { makeClient, sleep, dmy, mins, arg, stamp, BASE, LOC, CARD_SLUG, CARD_ID, AREAS, UA };
