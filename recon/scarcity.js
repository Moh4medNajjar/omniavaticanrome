// Read-only scarcity probe for the Vatican products: open dates (calendar) + sampled slot counts.
// Never calls create_or_update, so nothing is held. Writes out/scarcity.json.
const fs = require('fs');
const path = require('path');

const BASE = 'https://www.omniavaticanrome.org';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const CARDS = {
  'basilica-di-san-pietro-con-audioguida-e-salita-alla-cupola': 129,
  'visita-guidata-ufficiale-della-basilica-di-san-pietro': 6,
  'visita-guidata-della-necropoli-di-san-pietro': 135,
  'Visita-della-Necropoli-di-San-Pietro-e-della-Basilica': 132,
  'le-radici-del-martirio-san-pietro-carcere-e-gloria': 123,
  'omnia-card-24h': 16,
  'da-san-giovanni-a-san-pietro-la-chiesa-in-cammino': 115,
};
const HORIZON = 60;
const SAMPLE_OFFSETS = [2, 5, 9, 14, 21, 30, 45, 59];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d) => d.toISOString().slice(0, 10);

async function probe(slug, cardId) {
  const jar = {};
  const http = async (method, url, { form, headers = {} } = {}) => {
    await sleep(1200);
    const res = await fetch(url.startsWith('http') ? url : BASE + url, {
      method, redirect: 'manual', body: form ? new URLSearchParams(form).toString() : undefined,
      headers: { 'User-Agent': UA, Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}), ...headers },
    });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); }
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  };
  const card = await http('GET', `/it/cards/${slug}`);
  const token = card.text.match(/name="authenticity_token" value="([^"]+)"/)?.[1];
  const pax = await http('POST', '/it/cards/set_pax', { form: { utf8: '✓', authenticity_token: token, card: cardId, locale: 'it', max_limit: 7, min_limit: 0, adult: 1, child: 0, commit: 'Acquista' } });
  if (pax.status !== 302) return { error: `set_pax ${pax.status}` };
  const next = await http('GET', pax.location);
  const csrf = next.text.match(/name="csrf-token" content="([^"]+)"/)?.[1];
  const xhr = { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': csrf };
  const parts = next.text.split(/<form action="\/\w+\/vouchers\/reserve"/);
  const areas = {};
  for (let i = 1; i < parts.length; i++) {
    const area = parts[i].match(/name="area" id="area" value="(\w+)"/)?.[1];
    const multibook = parts[i].match(/name="multibook" id="multibook" value="(\w*)"/)?.[1] || '';
    const els = [...new Set([...parts[i - 1].matchAll(/name="elements\[\]" id="elements_" value="([^"]+)"/g)].map((m) => m[1]))].filter((e) => !e.endsWith('_0'));
    if (area && !areas[area]) areas[area] = { products: els.join('**'), multibook };
  }
  if (!Object.keys(areas).length) return { error: 'no bookable areas', landed: pax.location };
  const out = {};
  for (const [area, a] of Object.entries(areas)) {
    const w = await http('POST', '/it/vouchers/reserve', { headers: xhr, form: { area, buy_products: a.products, multibook: a.multibook } });
    const excluded = new Set(JSON.parse(w.text.match(/exclude_days\s*=\s*(\[[^\]]*\])/)?.[1] || '[]'));
    // use the availability form exactly as the widget renders it
    const f = w.text.match(/<form[^>]*id="checkout_get_availability"[\s\S]*?<\/form>/)?.[0] || '';
    const hidden = Object.fromEntries([...f.matchAll(/name="([^"]+)"[^>]*value="([^"]*)"/g)].filter((m) => !['utf8', 'authenticity_token'].includes(m[1])).map((m) => [m[1], m[2]]));
    const today = new Date();
    const open = [];
    for (let d = 0; d < HORIZON; d++) { const x = new Date(today); x.setDate(x.getDate() + d); if (!excluded.has(iso(x))) open.push(iso(x)); }
    const samples = {};
    for (const off of SAMPLE_OFFSETS) {
      const x = new Date(today); x.setDate(x.getDate() + off); const day = iso(x);
      if (excluded.has(day)) { samples[day] = 'closed'; continue; }
      const [Y, M, D] = day.split('-');
      const r = await http('POST', '/it/cards/get_availability', { headers: xhr, form: { ...hidden, area, data: `${D}-${M}-${Y}`, number_of_pax: 1 } });
      samples[day] = [...r.text.matchAll(/class='book__single_hour[^']*'[^>]*id='([^']+)'|id='(GRP_[^']+)'/g)].length;
    }
    out[area] = { openDaysNext60: open.length, samples, availabilityParams: hidden };
  }
  return out;
}

(async () => {
  const result = {};
  for (const [slug, id] of Object.entries(CARDS)) {
    try { result[slug] = await probe(slug, id); } catch (e) { result[slug] = { error: e.message }; }
    process.stdout.write('.');
  }
  fs.writeFileSync(path.join(__dirname, 'out', 'scarcity.json'), JSON.stringify(result, null, 2));
  console.log(' done');
})();
