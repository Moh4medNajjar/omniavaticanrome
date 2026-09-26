// Deeper booking-flow capture -> ./out2 (prints only a short status line).
// Drives: consent -> quantities -> Acquista (set_pax) -> calendar date -> group/lang/hour -> product qty -> buy_button (cart)
// STOPS on the cart/checkout page: never fills personal data, never pays, never submits the checkout form.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = 'https://www.omniavaticanrome.org';
const TARGET = BASE + '/it/cards/carcer-tullianum-colosseo-foro-romano-e-palatino';
const OUT = path.join(__dirname, 'out2');
const BODIES = path.join(OUT, 'bodies');
const STEPS = path.join(OUT, 'steps');
fs.mkdirSync(BODIES, { recursive: true });
fs.mkdirSync(STEPS, { recursive: true });

const log = [];
const steps = [];
let currentPhase = 'init';
let stepNo = 0;

function attach(page, t0) {
  page.on('request', (req) => {
    log.push({
      id: log.length, t: Date.now() - t0, phase: currentPhase,
      method: req.method(), url: req.url(), type: req.resourceType(),
      headers: req.headers(), postData: req.postData() || null,
      isNav: req.isNavigationRequest(),
      redirectedFrom: req.redirectedFrom() ? req.redirectedFrom().url() : null,
    });
    req._rid = log.length - 1;
  });
  page.on('response', async (res) => {
    const e = log[res.request()._rid];
    if (!e) return;
    e.status = res.status();
    e.respHeaders = await res.allHeaders().catch(() => res.headers());
    const ct = e.respHeaders['content-type'] || '';
    if (e.status >= 300 && e.status < 400) return;
    if (['xhr', 'fetch', 'document', 'script', 'other'].includes(e.type) && /json|text|javascript|html|xml/.test(ct)) {
      try {
        const body = await res.body();
        const f = crypto.createHash('md5').update(e.method + e.url + (e.postData || '')).digest('hex').slice(0, 12);
        const ext = /json/.test(ct) ? 'json' : /javascript/.test(ct) ? 'js' : /html/.test(ct) ? 'html' : 'txt';
        const fn = `${e.id}_${f}.${ext}`;
        fs.writeFileSync(path.join(BODIES, fn), body);
        e.bodyFile = `bodies/${fn}`;
      } catch {}
    }
  });
  page.on('requestfailed', (req) => { const e = log[req._rid]; if (e) e.failed = req.failure()?.errorText; });
}

async function snap(page, label) {
  stepNo++;
  const base = `${String(stepNo).padStart(2, '0')}_${label}`;
  const info = { step: stepNo, label, url: page.url(), phase: currentPhase };
  try { fs.writeFileSync(path.join(STEPS, base + '.html'), await page.content()); info.html = `steps/${base}.html`; } catch {}
  try { await page.screenshot({ path: path.join(STEPS, base + '.png'), fullPage: true }); info.png = `steps/${base}.png`; } catch {}
  info.forms = await page.evaluate(() => [...document.forms].map((f) => ({
    id: f.id || null, cls: f.className || null, action: f.getAttribute('action'), method: (f.getAttribute('method') || 'get').toLowerCase(),
    remote: f.getAttribute('data-remote'),
    fields: [...f.elements].filter((el) => el.name).map((el) => ({
      name: el.name, tag: el.tagName.toLowerCase(), type: el.type || null, id: el.id || null,
      value: el.type === 'password' ? '***' : (el.value || '').slice(0, 200),
      options: el.tagName === 'SELECT' ? [...el.options].map((o) => o.value).slice(0, 20) : undefined,
    })),
  }))).catch(() => []);
  info.body = await page.evaluate(() => ({ controller: document.body.dataset.controller, action: document.body.dataset.action })).catch(() => null);
  info.windowVars = await page.evaluate(() => {
    const keys = ['exclude_days', 'locale', 'supplements', 'alert_ko_hold_reservations_message', 'alert_invalid_cart_message', 'no_qta_title', 'lock_message', 'centered', 'geojson'];
    const o = {}; for (const k of keys) { try { if (window[k] !== undefined) o[k] = JSON.parse(JSON.stringify(window[k])); } catch {} } return o;
  }).catch(() => ({}));
  info.dataLayer = await page.evaluate(() => (window.dataLayer || []).map((d) => { try { return JSON.parse(JSON.stringify(d)); } catch { return String(d); } }).filter((d) => d && d.event && !/^gtm\./.test(d.event))).catch(() => []);
  steps.push(info);
  return info;
}

async function clickIf(page, sel, opts = {}) {
  const loc = page.locator(sel);
  const n = await loc.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const el = loc.nth(i);
    if (await el.isVisible().catch(() => false)) {
      await el.click({ timeout: 5000, ...opts }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function waitQuiet(page, ms = 2500) {
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(ms);
}

async function acceptConsent(page) {
  for (const sel of ['.iubenda-cs-accept-btn', 'button:has-text("Accetta")', 'button:has-text("Accept")', 'button:has-text("OK")']) {
    if (await clickIf(page, sel)) return true;
  }
  return false;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    recordHar: { path: path.join(OUT, 'session.har'), content: 'embed' },
    locale: 'it-IT',
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();
  const t0 = Date.now();
  attach(page, t0);
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  const notes = [];

  // 1. load + consent
  currentPhase = 'load';
  await page.goto(TARGET, { waitUntil: 'networkidle', timeout: 90000 }).catch(() => {});
  currentPhase = 'consent';
  notes.push({ consentClicked: await acceptConsent(page) });
  await waitQuiet(page, 3000);
  await snap(page, 'card_page');

  // 2. quantities: 1 adult, 1 child (6-17)
  currentPhase = 'set_quantities';
  await page.selectOption('select#adult', '1').catch(() => {});
  await page.selectOption('select#child', '1').catch(() => {});
  await page.waitForTimeout(800);

  // 3. Acquista -> form POST /it/cards/set_pax
  currentPhase = 'set_pax_submit';
  await Promise.all([
    page.waitForNavigation({ timeout: 30000 }).catch(() => {}),
    clickIf(page, 'form[action*="set_pax"] input.add_to_cart'),
  ]);
  await waitQuiet(page, 3000);
  await snap(page, 'after_set_pax');

  // 4..7 per booking area on the multitickets page (CM = Carcere Mamertino, CL = Colosseo)
  let dayPickedCM = null;
  for (const area of ['CM', 'CL']) {
    if (!page.url().includes('multitickets')) break;
    // 4a. "Prenota" for the area -> POST /{loc}/vouchers/reserve (xhr, HTML fragment with datepicker)
    currentPhase = `reserve_${area}`;
    await clickIf(page, `#area_${area} .book_area`);
    await waitQuiet(page, 3000);
    const zone = `#area_${area} .multibook__book_area`;
    await snap(page, `book_area_${area}`);
    // 4b. calendar: first enabled day (tries up to 2 extra months)
    currentPhase = `pick_date_${area}`;
    let dayPicked = null;
    for (let attempt = 0; attempt < 3 && !dayPicked; attempt++) {
      const days = page.locator(`${zone} #book__datepicker td.day:not(.disabled):not(.old):not(.new)`);
      const dn = await days.count().catch(() => 0);
      for (let i = 0; i < Math.min(dn, 8); i++) {
        const d = days.nth(i);
        if (!(await d.isVisible().catch(() => false))) continue;
        const txt = (await d.getAttribute('data-day').catch(() => null)) || (await d.innerText().catch(() => ''));
        // CL must be >= CM date (and >=1h after): prefer same day as CM
        if (area === 'CL' && dayPickedCM && txt !== dayPickedCM) {
          const all = page.locator(`${zone} #book__datepicker td.day[data-day="${dayPickedCM}"]:not(.disabled)`);
          if (await all.count().catch(() => 0)) { await all.first().click({ timeout: 4000 }).catch(() => {}); await waitQuiet(page, 3000); dayPicked = dayPickedCM; break; }
        }
        await d.click({ timeout: 4000 }).catch(() => {});
        await waitQuiet(page, 3000);
        const opts = await page.locator(`${zone} #book__groups li, ${zone} .book__chose_group, ${zone} .book__single_hour`).count().catch(() => 0);
        if (opts > 0) { dayPicked = txt; break; }
      }
      if (!dayPicked) { await clickIf(page, `${zone} #book__datepicker th.next`); await page.waitForTimeout(1200); }
    }
    if (area === 'CM') dayPickedCM = dayPicked;
    notes.push({ area, dayPicked });
    await snap(page, `after_date_${area}`);

    // 5. group -> language -> hour (hour chosen: for CL take a later slot than CM)
    currentPhase = `pick_slot_${area}`;
    await clickIf(page, `${zone} .book__chose_group`);
    await page.waitForTimeout(1500);
    await clickIf(page, `${zone} .book__chose_lang`);
    await page.waitForTimeout(1500);
    const hours = page.locator(`${zone} .book__single_hour:visible`);
    const hn = await hours.count().catch(() => 0);
    const pick = area === 'CL' ? Math.min(hn - 1, 3) : 0;
    let hourClicked = null;
    if (hn > 0) { await hours.nth(Math.max(pick, 0)).click({ timeout: 4000 }).catch(() => {}); hourClicked = (await hours.nth(Math.max(pick, 0)).innerText().catch(() => '')).trim().slice(0, 40); }
    notes.push({ area, hourCount: hn, hourClicked });
    await page.waitForTimeout(2000);
    await snap(page, `after_hour_${area}`);

    // 6. product quantity +/- (form#load_products) if present
    currentPhase = `product_qty_${area}`;
    const plus1 = await clickIf(page, `${zone} .products_box.active .plus`);
    await waitQuiet(page, 2000);
    const minus1 = await clickIf(page, `${zone} .products_box.active .minus`);
    await waitQuiet(page, 2000);
    notes.push({ area, plus1, minus1 });

    // 7. buy_button -> GET /check_valid_products, POST form#manage_voucher -> JSON {url}|{hold:"ko"}
    currentPhase = `add_to_cart_${area}`;
    // NOTE: this creates real temporary reservation holds server-side. Set NO_HOLD=1 to skip.
    const buy = process.env.NO_HOLD ? false : ((await clickIf(page, `${zone} .buy_button`)) || (await clickIf(page, `${zone} .hold_button, ${zone} .book_button`)));
    notes.push({ area, buyClicked: buy });
    await page.waitForTimeout(6000);
    await waitQuiet(page, 3000);
    await snap(page, `after_buy_${area}`);
  }
  await snap(page, 'cart');

  // 8. proceed toward checkout (only navigation links/buttons, never submit #form-checkout)
  currentPhase = 'toward_checkout';
  const proceed = page.locator('a:has-text("Procedi"), a:has-text("Continua"), a:has-text("Checkout"), a:has-text("Prosegui"), a:has-text("Vai alla cassa")');
  if (await proceed.count().catch(() => 0)) {
    await Promise.all([page.waitForNavigation({ timeout: 20000 }).catch(() => {}), proceed.first().click({ timeout: 5000 }).catch(() => {})]);
    await waitQuiet(page, 3000);
    await snap(page, 'checkout_page');
  }
  // STOP here: no personal data entered, #form-checkout never submitted, no payment.

  // 9. English version + another card (shared endpoints)
  // cart page (GET only; checkout form is NOT filled nor submitted)
  currentPhase = 'cart_page';
  await page.goto(BASE + '/it/vouchers/checkout', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await waitQuiet(page, 2000);
  await snap(page, 'vouchers_checkout');

  currentPhase = 'lang_switch';
  await page.goto(BASE + '/change-language?l=en&locale=it', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await waitQuiet(page, 1500);
  await snap(page, 'change_language');
  currentPhase = 'lang_en';
  await page.goto(TARGET.replace('/it/', '/en/'), { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await waitQuiet(page, 2000);
  await snap(page, 'card_en');

  currentPhase = 'other_card';
  await page.goto(BASE + '/it/cards/colosseo-foro-romano-palatino-e-carcer-tullianum-visita-guidata', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await waitQuiet(page, 2000);
  await snap(page, 'other_card');

  currentPhase = 'omnia_list';
  await page.goto(BASE + '/it/omnia', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await waitQuiet(page, 2000);
  await snap(page, 'omnia');

  // Return to cart to observe cart state endpoint (if a cart link exists in header)
  currentPhase = 'cart_revisit';
  const cartLink = await page.locator('a[href*="cart"], a[href*="carrello"], a[href*="checkout"]').first().getAttribute('href').catch(() => null);
  notes.push({ cartLink });
  if (cartLink) {
    await page.goto(new URL(cartLink, BASE).href, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
    await waitQuiet(page, 2000);
    await snap(page, 'cart_revisit');
  }

  const cookies = await context.cookies();
  fs.writeFileSync(path.join(OUT, 'cookies.json'), JSON.stringify(cookies, null, 2));
  const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })).catch(() => ({}));
  fs.writeFileSync(path.join(OUT, 'storage.json'), JSON.stringify(storage, null, 2));
  fs.writeFileSync(path.join(OUT, 'steps.json'), JSON.stringify(steps, null, 2));
  fs.writeFileSync(path.join(OUT, 'notes.json'), JSON.stringify(notes, null, 2));
  fs.writeFileSync(path.join(OUT, 'requests.json'), JSON.stringify(log, null, 2));
  await context.close();
  await browser.close();
  console.log(`captured ${log.length} requests, ${steps.length} steps`);
})();
