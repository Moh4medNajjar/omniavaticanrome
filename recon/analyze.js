// Builds a structured request/API map from out/requests.json + downloaded JS/HTML. Writes files only.
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'out');
const log = JSON.parse(fs.readFileSync(path.join(OUT, 'requests.json'), 'utf8'));

const shape = (v, d = 0) => {
  if (d > 4) return '…';
  if (Array.isArray(v)) return v.length ? [shape(v[0], d + 1)] : [];
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, shape(x, d + 1)]));
  return v === null ? 'null' : typeof v;
};

const byHost = {};
const endpoints = {};
for (const e of log) {
  let u; try { u = new URL(e.url); } catch { continue; }
  (byHost[u.host] ||= { count: 0, types: {} }).count++;
  byHost[u.host].types[e.type] = (byHost[u.host].types[e.type] || 0) + 1;
  if (!['xhr', 'fetch', 'document', 'other', 'ping', 'eventsource', 'websocket'].includes(e.type)) continue;
  const key = `${e.method} ${u.origin}${u.pathname}`;
  const ep = (endpoints[key] ||= { method: e.method, origin: u.origin, path: u.pathname, types: new Set(), phases: new Set(), statuses: new Set(), queryKeys: new Set(), samples: [], reqHeaders: {}, respContentType: null, bodyShape: null, postShape: null });
  ep.types.add(e.type); ep.phases.add(e.phase); if (e.status) ep.statuses.add(e.status);
  u.searchParams.forEach((_, k) => ep.queryKeys.add(k));
  if (ep.samples.length < 3) ep.samples.push({ url: e.url, postData: e.postData ? e.postData.slice(0, 1500) : null, bodyFile: e.bodyFile || null });
  for (const h of ['content-type', 'authorization', 'x-requested-with', 'x-csrf-token', 'x-xsrf-token', 'accept', 'origin', 'referer']) if (e.headers?.[h]) ep.reqHeaders[h] = h === 'authorization' ? '[present]' : e.headers[h];
  ep.respContentType ||= e.respHeaders?.['content-type'] || null;
  if (e.bodyFile && /json/.test(ep.respContentType || '') && !ep.bodyShape) {
    try { ep.bodyShape = shape(JSON.parse(fs.readFileSync(path.join(OUT, e.bodyFile), 'utf8'))); } catch {}
  }
  if (e.postData && !ep.postShape) { try { ep.postShape = shape(JSON.parse(e.postData)); } catch { ep.postShape = e.postData.slice(0, 300); } }
}

// Static discovery: endpoints referenced inside JS/HTML (may never be called on this page)
const staticRefs = {};
const rxs = [
  /["'`](\/(?:api|ajax|wp-json|graphql|rest|v\d|booking|cart|checkout|availability|calendar|tickets?|products?|cards?|orders?|payment|user|auth|session)[^"'`\s<>]{0,160})["'`]/gi,
  /["'`](https?:\/\/[^"'`\s<>]{4,200})["'`]/gi,
  /(?:fetch|axios(?:\.\w+)?|\$\.(?:ajax|get|post|getJSON)|open)\(\s*["'`]([^"'`]{2,200})["'`]/gi,
  /(?:url|endpoint|action|baseURL|apiUrl|api_url)\s*[:=]\s*["'`]([^"'`]{2,200})["'`]/gi,
];
for (const f of fs.readdirSync(path.join(OUT, 'bodies')).concat(['../page.html'])) {
  if (!/\.(js|html)$/.test(f)) continue;
  const src = fs.readFileSync(path.join(OUT, 'bodies', f), 'utf8');
  for (const rx of rxs) for (const m of src.matchAll(rx)) {
    const v = m[1];
    if (/\.(png|jpe?g|svg|gif|webp|woff2?|ttf|css|ico)(\?|$)/i.test(v)) continue;
    (staticRefs[v] ||= new Set()).add(f);
  }
}

const ser = (o) => JSON.parse(JSON.stringify(o, (k, v) => (v instanceof Set ? [...v] : v)));
fs.writeFileSync(path.join(OUT, 'map.json'), JSON.stringify(ser({ byHost, endpoints, staticRefs }), null, 2));
console.log(`hosts=${Object.keys(byHost).length} endpoints=${Object.keys(endpoints).length} staticRefs=${Object.keys(staticRefs).length}`);
