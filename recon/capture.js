// Captures every network request made by the target page into ./out (nothing printed except a status line).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TARGET = 'https://www.omniavaticanrome.org/it/cards/carcer-tullianum-colosseo-foro-romano-e-palatino';
const OUT = path.join(__dirname, 'out');
const BODIES = path.join(OUT, 'bodies');
fs.mkdirSync(BODIES, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    recordHar: { path: path.join(OUT, 'session.har'), content: 'embed' },
    locale: 'it-IT',
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();
  const log = [];
  const t0 = Date.now();

  page.on('request', (req) => {
    log.push({
      id: log.length, t: Date.now() - t0, phase: currentPhase,
      method: req.method(), url: req.url(), type: req.resourceType(),
      headers: req.headers(), postData: req.postData() || null,
    });
    req._rid = log.length - 1;
  });
  page.on('response', async (res) => {
    const e = log[res.request()._rid];
    if (!e) return;
    e.status = res.status();
    e.respHeaders = res.headers();
    const ct = e.respHeaders['content-type'] || '';
    if (['xhr', 'fetch', 'document', 'script', 'other'].includes(e.type) && /json|text|javascript|html|xml/.test(ct)) {
      try {
        const body = await res.body();
        const f = crypto.createHash('md5').update(e.method + e.url + (e.postData || '')).digest('hex').slice(0, 12);
        const ext = /json/.test(ct) ? 'json' : /javascript/.test(ct) ? 'js' : /html/.test(ct) ? 'html' : 'txt';
        fs.writeFileSync(path.join(BODIES, `${e.id}_${f}.${ext}`), body);
        e.bodyFile = `bodies/${e.id}_${f}.${ext}`;
      } catch {}
    }
  });
  page.on('requestfailed', (req) => { const e = log[req._rid]; if (e) e.failed = req.failure()?.errorText; });

  let currentPhase = 'load';
  await page.goto(TARGET, { waitUntil: 'networkidle', timeout: 90000 }).catch(() => {});
  fs.writeFileSync(path.join(OUT, 'page.html'), await page.content());

  // Accept cookie banner if present (enables consent-gated trackers/APIs)
  currentPhase = 'consent';
  for (const sel of ['button:has-text("Accetta")', 'button:has-text("Accept")', '#onetrust-accept-btn-handler', '.cc-allow', 'button:has-text("OK")']) {
    const b = page.locator(sel).first();
    if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); break; }
  }
  await page.waitForTimeout(3000);

  currentPhase = 'scroll';
  for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 700); await page.waitForTimeout(500); }
  await page.waitForTimeout(2000);

  // Try to trigger booking/availability flows (calendar, date, quantity, buy buttons)
  currentPhase = 'interact';
  const candidates = page.locator('button, a, [role="button"], input[type="date"], .datepicker, [class*="calendar"] td, [class*="day"]');
  const n = Math.min(await candidates.count().catch(() => 0), 400);
  const texts = [];
  for (let i = 0; i < n; i++) {
    const el = candidates.nth(i);
    const txt = ((await el.innerText().catch(() => '')) || '').trim().slice(0, 60);
    const href = await el.getAttribute('href').catch(() => null);
    texts.push({ i, txt, href });
  }
  fs.writeFileSync(path.join(OUT, 'clickables.json'), JSON.stringify(texts, null, 2));
  const rx = /(acquist|prenot|compra|book|buy|data|date|disponib|calend|biglie|ticket|aggiung|continua|\+)/i;
  const clicked = [];
  for (const c of texts.filter((c) => rx.test(c.txt) && !(c.href && /^https?:/.test(c.href) && !c.href.includes('omniavaticanrome'))).slice(0, 15)) {
    const el = candidates.nth(c.i);
    if (!(await el.isVisible().catch(() => false))) continue;
    await el.click({ timeout: 3000 }).catch(() => {});
    clicked.push(c.txt);
    await page.waitForTimeout(2500);
    if (!page.url().includes('carcer-tullianum')) { await page.goBack().catch(() => {}); await page.waitForTimeout(2000); }
  }
  // Click some enabled calendar days if a calendar appeared
  const days = page.locator('[class*="calendar"] :is(td,button,div)[class*="available"], .flatpickr-day:not(.flatpickr-disabled), .ui-datepicker-calendar a, [class*="day"]:not([class*="disabled"])');
  const dn = Math.min(await days.count().catch(() => 0), 3);
  for (let i = 0; i < dn; i++) { await days.nth(i).click({ timeout: 3000 }).catch(() => {}); clicked.push('day#' + i); await page.waitForTimeout(2500); }
  await page.waitForTimeout(3000);
  fs.writeFileSync(path.join(OUT, 'clicked.json'), JSON.stringify(clicked, null, 2));
  fs.writeFileSync(path.join(OUT, 'final_url.txt'), page.url());
  await page.screenshot({ path: path.join(OUT, 'final.png'), fullPage: true }).catch(() => {});

  const cookies = await context.cookies();
  fs.writeFileSync(path.join(OUT, 'cookies.json'), JSON.stringify(cookies, null, 2));
  const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })).catch(() => ({}));
  fs.writeFileSync(path.join(OUT, 'storage.json'), JSON.stringify(storage, null, 2));

  fs.writeFileSync(path.join(OUT, 'requests.json'), JSON.stringify(log, null, 2));
  await context.close();
  await browser.close();
  console.log(`captured ${log.length} requests`);
})();
