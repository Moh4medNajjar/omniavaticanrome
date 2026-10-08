// What happens after the pay form? Holds 1 CM + 1 CL seat, prints the checkout form, and
// with --submit posts it with placeholder buyer details (nothing is paid: the PSP redirect
// is not followed). Then reads /vouchers/thankyoupage and /vouchers/checkout with the same
// session, to learn whether an unpaid order already shows the thank-you page.
const { makeClient, BASE, LOC } = require('../lib/client');
const { openSession, getSlots, holdPair, releasePair } = require('../lib/site');

const date = process.argv[2] || '2026-11-20';
const submit = process.argv.includes('--submit');
const pick = (s) => s.match(/<form[^>]*id="form-checkout"[\s\S]*?<\/form>/)?.[0] || '';

(async () => {
  const c = makeClient(null);
  const { csrf } = await openSession(c);
  const cm = await getSlots(c, csrf, 'CM', date, 1);
  const cl = await getSlots(c, csrf, 'CL', date, 1);
  c.close();
  console.log(`${date}: ${cm.length} CM slots, ${cl.length} CL slots`);
  const pair = await holdPair(date, cm[0], cl[cl.length - 1], null);
  if (!pair) throw new Error('could not hold a pair');
  const { http } = pair.client;
  try {
    const co = await http('GET', `${BASE}/${LOC}/vouchers/checkout`);
    const form = pick(co.text);
    console.log(`checkout HTTP ${co.status}, form ${form.length}B`);
    console.log(form.replace(/<option[\s\S]*?<\/option>/g, '').replace(/\n\s*\n/g, '\n').slice(0, 6000));
    for (const m of co.text.matchAll(/<input[^>]*name=.payment-check[^>]*>/g)) console.log('PAYCHECK', m[0]);
    if (!submit) return;

    const fields = {};
    for (const m of form.matchAll(/<input[^>]*>/g)) {
      const attr = (k) => m[0].match(new RegExp(`${k}=["']([^"']*)["']`))?.[1];
      const name = attr('name');
      if (!name) continue;
      const type = attr('type') || 'text';
      const value = attr('value') ?? '';
      if (type === 'checkbox') fields[name] = value || '1';
      else if (type !== 'radio' && type !== 'submit') fields[name] = value;
    }
    Object.assign(fields, { nome: 'Test', cognome: 'Probe', nazionalita: 'IT', email: 'probe@example.com', tel: '3331234567' });
    const action = form.match(/action="([^"]+)"/)?.[1] || `/${LOC}/vouchers/pay`;
    console.log('POST', action, Object.keys(fields).join(','));
    const pay = await http('POST', action.startsWith('http') ? action : BASE + action, { form: fields });
    console.log(`pay HTTP ${pay.status} location=${pay.location}`);
    const page = pay.status === 200 ? pay : await http('GET', pay.location.startsWith('http') ? pay.location : BASE + pay.location);
    console.log(`next page HTTP ${page.status} location=${page.location} body=${page.text.match(/<body[^>]*>/)?.[0]}`);
    for (const m of page.text.matchAll(/<form[\s\S]*?<\/form>/g)) console.log('FORM', m[0].replace(/\s+/g, ' ').slice(0, 1500));
    for (const m of page.text.matchAll(/https?:\/\/[^"' ]*(paypal|moneta|nexi|setefi)[^"' ]*/gi)) console.log('PSP', m[0]);
    const main = page.text.replace(/<head>[\s\S]*?<\/head>/, '').replace(/<(header|footer|nav)[\s\S]*?<\/\1>/g, '');
    require('fs').writeFileSync('pay_page.html', page.text);
    const card = await http('GET', `${BASE}/prepare-credit-card?locale=it`);
    console.log(`CARD prepare HTTP ${card.status} location=${card.location}`);
    require('fs').writeFileSync('card_page.html', card.text);
    for (const m of page.text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
      if (/paypal|thankyou|moneta|credit/i.test(m[0])) console.log('SCRIPT', m[0].replace(/\s+/g, ' ').slice(0, 3000));
    }

    for (const [label, path] of [['thankyou', '/vouchers/thankyoupage'], ['checkout', '/vouchers/checkout']]) {
      const r = await http('GET', `${BASE}/${LOC}${path}`);
      const body = r.text.match(/<body[^>]*>/)?.[0] || '';
      console.log(`${label} HTTP ${r.status} location=${r.location} body=${body} voucher=${/data-voucher/.test(r.text)}`);
    }
  } finally {
    console.log('released:', await releasePair(pair));
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
