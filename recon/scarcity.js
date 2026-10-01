// Read-only scarcity probe for every product on the site: open dates (calendar) + sampled slot counts.
// Never calls create_or_update, so nothing is held. Writes out/scarcity.json and raw pages to out/live/.
//   node scarcity.js [--pax N] [slug ...]
const fs = require('fs');
const path = require('path');

const BASE = 'https://www.omniavaticanrome.org';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const OUT = path.join(__dirname, 'out');
const LIVE = path.join(OUT, 'live');
fs.mkdirSync(LIVE, { recursive: true });

// Cards are discovered from these pages; SEED covers cards that are not linked from them.
const INDEX_PAGES = ['/it', '/it/omnia', '/it/pages/proposte', '/it/pages/prenota-ingressi'];
const SEED = [
  'basilica-di-san-pietro-con-audioguida-e-salita-alla-cupola',
  'basilica-di-santa-maria-maggiore-ingresso-con-accompagnatore-e-audioguida-multilingue',
  'carcer-tullianum-colosseo-foro-romano-e-palatino',
  'carcer-tullianum-colosseo-foro-romano-palatino-e-audioguida',
  'colosseo-foro-romano-palatino-e-carcer-tullianum-visita-guidata',
  'da-san-giovanni-a-san-pietro-la-chiesa-in-cammino',
  'il-carcer-tullianum',
  'il-palazzo-lateranense-la-casa-del-vescovo-di-roma-visita-guidata',
  'il-servizio-open-bus-vatican-rome',
  'le-radici-del-martirio-san-pietro-carcere-e-gloria',
  'luoghi-di-fede-tempo-della-chiesa',
  'omnia-card-24h',
  'omnia-card-72h',
  'omnia-smart',
  'Visita-della-Necropoli-di-San-Pietro-e-della-Basilica',
  'visita-guidata-della-necropoli-di-san-pietro',
  'visita-guidata-ufficiale-della-basilica-di-san-pietro',
];
const NOT_CARDS = new Set(['set_pax', 'fix_pax', 'multitickets', 'book', 'get_availability']);
const HORIZON = 120; // days ahead
const FIRST_SAMPLES = 4; // earliest open dates
const SPREAD_SAMPLES = 4; // evenly spread over the rest
const DELAY_MS = 1100;
// --pax N: probe for a party of N people (default 1). Results go to out/scarcity_paxN.json.
const paxArg = process.argv.indexOf('--pax');
const PAX = paxArg > 0 ? Number(process.argv[paxArg + 1]) : 1;
const RESULT_FILE = path.join(OUT, PAX === 1 ? 'scarcity.json' : `scarcity_pax${PAX}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d) => d.toISOString().slice(0, 10);
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&#x2713;/g, '✓');

function client() {
  const jar = {};
  return async (method, url, { form, headers = {} } = {}) => {
    await sleep(DELAY_MS);
    const res = await fetch(url.startsWith('http') ? url : BASE + url, {
      method, redirect: 'manual', body: form ? new URLSearchParams(form).toString() : undefined,
      headers: { 'User-Agent': UA, 'Accept-Language': 'it-IT,it;q=0.9', Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}), ...headers },
    });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); }
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  };
}

async function discover() {
  const http = client();
  const slugs = new Set(SEED);
  for (const p of INDEX_PAGES) {
    const r = await http('GET', p).catch(() => null);
    if (!r || r.status !== 200) continue;
    for (const m of r.text.matchAll(/href="(?:https?:\/\/[^"\/]+)?\/it\/cards\/([^"?#\/]+)"/g)) if (!NOT_CARDS.has(m[1])) slugs.add(m[1]);
  }
  return [...slugs];
}

// Calendar + sampled slots for one area. `widget` is the HTML holding exclude_days and the availability form.
async function probeArea(http, xhr, widget, area) {
  const ex = widget.match(/exclude_days\s*=\s*(\[[^\]]*\])/)?.[1];
  if (!ex) return { error: 'no calendar in widget' };
  const excluded = new Set(JSON.parse(ex));
  // use the availability form exactly as the widget renders it
  const f = widget.match(/<form[^>]*id="checkout_get_availability"[\s\S]*?<\/form>/)?.[0] || '';
  const hidden = Object.fromEntries([...f.matchAll(/name="([^"]+)"[^>]*value="([^"]*)"/g)].filter((m) => !['utf8', 'authenticity_token', 'data'].includes(m[1])).map((m) => [m[1], m[2]]));
  const open = [];
  const today = new Date();
  for (let d = 0; d < HORIZON; d++) { const x = new Date(today); x.setDate(x.getDate() + d); if (!excluded.has(iso(x))) open.push({ day: iso(x), off: d }); }
  const rest = open.slice(FIRST_SAMPLES);
  const picks = new Set(open.slice(0, FIRST_SAMPLES).map((o) => o.day));
  for (let i = 0; i < SPREAD_SAMPLES && rest.length; i++) picks.add(rest[Math.floor(((i + 0.5) * rest.length) / SPREAD_SAMPLES)].day);
  const samples = {};
  for (const day of [...picks].sort()) {
    const [Y, M, D] = day.split('-');
    const r = await http('POST', '/it/cards/get_availability', { headers: xhr, form: { ...hidden, area, data: `${D}-${M}-${Y}` } });
    if (r.status !== 200) { samples[day] = { error: `HTTP ${r.status}` }; continue; }
    const ids = [...r.text.matchAll(/class='book__single_hour[^']*'\s+id='([^']+)'/g)].map((m) => m[1]);
    const times = [...new Set(ids.map((id) => id.match(/(\d\d:\d\d)$/)?.[1]).filter(Boolean))].sort();
    samples[day] = ids.length ? { slots: ids.length, times } : { slots: 0, message: r.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) };
  }
  const within = (n) => open.filter((o) => o.off < n).length;
  return { open30: within(30), open60: within(60), open120: within(120), firstOpen: open[0]?.day || null, lastOpen: open.at(-1)?.day || null, samples, availabilityParams: hidden };
}

async function probe(slug) {
  const http = client();
  const card = await http('GET', `/it/cards/${slug}`);
  if (card.status !== 200) return { error: `card page HTTP ${card.status}`, location: card.location };
  fs.writeFileSync(path.join(LIVE, `${slug}.card.html`), card.text);
  const out = {
    title: unescape(card.text.match(/class='card__title'>([^<]*)/)?.[1] || card.text.match(/<title>([^<]*)/)?.[1] || '').trim(),
    products: [...card.text.matchAll(/data-product='([^']*)'/g)].map((m) => { try { const p = JSON.parse(unescape(m[1])); return { name: p.name.trim(), code: p.id, price: p.price }; } catch { return null; } }).filter(Boolean),
  };
  const form = card.text.match(/<form[^>]*action="(\/\w+\/cards\/(?:set_pax|fix_pax))"[\s\S]*?<\/form>/);
  if (!form) return { ...out, error: 'no purchase form on card page' };
  const fields = {};
  for (const tag of form[0].match(/<input[^>]*>/g) || []) {
    const name = tag.match(/name="([^"]+)"/)?.[1];
    if (name && /type="hidden"/.test(tag)) fields[name] = unescape(tag.match(/value="([^"]*)"/)?.[1] || '');
  }
  const selects = [...form[0].matchAll(/<select[^>]*name="([^"]+)"/g)].map((m) => m[1]);
  out.cardId = Number(fields.card);
  out.tiers = [...form[0].matchAll(/class='form__label'>([^<]*)</g)].map((m) => unescape(m[1]).trim());
  if (!selects.length) return { ...out, error: 'no quantity selectors on card page' };
  // the whole party in the first tier (within the card's limits), zero in the others
  out.pax = Math.min(Math.max(PAX, Number(fields.min_limit) || 0), Number(fields.max_limit) || PAX);
  selects.forEach((s, i) => { fields[s] = i === 0 ? out.pax : 0; });
  let next = await http('POST', form[1], { form: { ...fields, commit: 'Acquista' } });
  if (next.status !== 302) return { ...out, error: `set_pax HTTP ${next.status}` };
  for (let hop = 0; hop < 4 && next.status >= 300 && next.status < 400 && next.location; hop++) { out.landed = next.location.replace(BASE, ''); next = await http('GET', next.location); }
  if (next.status !== 200) return { ...out, error: `landing HTTP ${next.status}` };
  fs.writeFileSync(path.join(LIVE, `${slug}.landing.html`), next.text);
  const csrf = next.text.match(/name="csrf-token" content="([^"]+)"/)?.[1];
  const xhr = { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': csrf };
  out.areas = {};

  // multitickets layout: one "Prenota" form per area, the calendar comes from vouchers/reserve
  const parts = next.text.split(/<form[^>]*action="\/\w+\/vouchers\/reserve"/);
  const areas = {};
  for (let i = 1; i < parts.length; i++) {
    const area = parts[i].match(/name="area" id="area" value="(\w+)"/)?.[1];
    const multibook = parts[i].match(/name="multibook" id="multibook" value="(\w*)"/)?.[1] || '';
    const els = [...new Set([...parts[i - 1].matchAll(/name="elements\[\]" id="elements_" value="([^"]+)"/g)].map((m) => m[1]))].filter((e) => !e.endsWith('_0'));
    if (area && !areas[area]) areas[area] = { products: els.join('**'), multibook };
  }
  for (const [area, a] of Object.entries(areas)) {
    const w = await http('POST', '/it/vouchers/reserve', { headers: xhr, form: { area, buy_products: a.products, multibook: a.multibook } });
    out.areas[area] = w.status === 200 ? { products: a.products, ...(await probeArea(http, xhr, w.text, area)) } : { error: `reserve HTTP ${w.status}` };
  }
  // book layout: the landing page itself holds the calendar for a single area
  if (!Object.keys(areas).length && /exclude_days\s*=/.test(next.text)) {
    const area = next.text.match(/<form[^>]*id="checkout_get_availability"[\s\S]*?name="area"[^>]*value="(\w+)"/)?.[1];
    if (area) out.areas[area] = await probeArea(http, xhr, next.text, area);
  }
  if (!Object.keys(out.areas).length) out.note = 'no bookable calendar on landing page';
  return out;
}

(async () => {
  const only = process.argv.slice(2).filter((a, i, all) => a !== '--pax' && all[i - 1] !== '--pax');
  const slugs = only.length ? only : await discover();
  const result = { probedAt: new Date().toISOString(), horizonDays: HORIZON, pax: PAX, cards: {} };
  for (const slug of slugs) {
    try { result.cards[slug] = await probe(slug); } catch (e) { result.cards[slug] = { error: e.message }; }
    const c = result.cards[slug];
    console.log(`${slug}: ${c.error || c.note || Object.entries(c.areas).map(([a, v]) => `${a} open30=${v.open30} open120=${v.open120} first=${v.firstOpen}${v.error ? ' ' + v.error : ''}`).join(' | ')}`);
    fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
  }
  console.log('done');
})();
