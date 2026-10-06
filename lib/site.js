// Site interactions: session management, slot queries, hold/release.

const { makeClient, BASE, LOC, CARD_SLUG, CARD_ID, AREAS, dmy, sleep } = require('./client');

function xhrHeaders(csrf) {
  return { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': csrf };
}

// Reservation codes held by the session, read from the "release" form the site renders
// for each held area (value="RSAB…**RSAB…"). A loose RS… pattern over the whole reply
// also matches random text inside its security tokens, about once per 1,000 replies.
function reservationCodes(html) {
  const codes = new Set();
  for (const tag of String(html || '').match(/<input[^>]*name="reservations"[^>]*>/g) || []) {
    for (const code of (tag.match(/value="([^"]*)"/)?.[1] || '').split('**')) {
      if (code) codes.add(code);
    }
  }
  return [...codes];
}

async function openSession(client, { adults = 1, children = 0 } = {}) {
  const { http } = client;
  const card = await http('GET', `${BASE}/${LOC}/cards/${CARD_SLUG}`);
  const formToken = card.text.match(/name="authenticity_token" value="([^"]+)"/)?.[1];
  if (card.status !== 200 || !formToken) throw new Error(`card page ${card.status}`);
  const maxLimit = Number(card.text.match(/name="max_limit" id="max_limit" value="(\d+)"/)?.[1] || 7);
  await http('POST', `${BASE}/${LOC}/cards/set_pax`, {
    form: { utf8: '✓', authenticity_token: formToken, card: CARD_ID, locale: LOC,
      max_limit: maxLimit, min_limit: 0, adult: adults, child: children, student: 0, newborn: 0, commit: 'Acquista' },
  });
  const mt = await http('GET', `${BASE}/${LOC}/cards/multitickets`);
  const csrf = mt.text.match(/name="csrf-token" content="([^"]+)"/)?.[1];
  if (!csrf) throw new Error('no csrf on multitickets');
  return { csrf, maxLimit, multitickets: mt.text };
}

async function getExcludedDays(client, csrf, area) {
  const { http } = client;
  const r = await http('POST', `${BASE}/${LOC}/vouchers/reserve`, {
    headers: xhrHeaders(csrf),
    form: { area, buy_products: `${AREAS[area].code}_1`, multibook: 'multitickets' },
  });
  if (r.status !== 200) throw new Error(`reserve ${area} ${r.status}`);
  return new Set(JSON.parse(r.text.match(/exclude_days\s*=\s*(\[[^\]]*\])/)?.[1] || '[]'));
}

async function getSlots(client, csrf, area, date, pax = 1) {
  const { http } = client;
  const r = await http('POST', `${BASE}/${LOC}/cards/get_availability`, {
    headers: xhrHeaders(csrf),
    form: { area, data: dmy(date), groups: 'IND', layout: 'horizontal', number_of_pax: pax },
  });
  if (r.status !== 200) throw new Error(`get_availability ${area} ${r.status}`);
  return [...r.text.matchAll(/id='(GRP_\d+_IND_[\d-]+_(\d\d:\d\d))'/g)].map((m) => ({ id: m[1], time: m[2] }));
}

function openDates(excluded, days = 120) {
  const out = [];
  const d = new Date();
  for (let i = 0; i < days; i++, d.setDate(d.getDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    if (!excluded.has(iso)) out.push(iso);
  }
  return out;
}

async function holdPair(date, cmSlot, clSlot, proxyUrl) {
  const client = makeClient(proxyUrl);
  let csrf;
  try {
    ({ csrf } = await openSession(client));
  } catch (e) { client.close(); return null; }
  const cmCodes = [], clCodes = [];
  let checkoutUrl = null;

  for (const [area, slot, codes] of [['CM', cmSlot, cmCodes], ['CL', clSlot, clCodes]]) {
    const { http } = client;
    await http('POST', `${BASE}/${LOC}/vouchers/reserve`, {
      headers: xhrHeaders(csrf), form: { area, buy_products: `${AREAS[area].code}_1`, multibook: 'multitickets' },
    });
    const r = await http('POST', `${BASE}/${LOC}/vouchers/create_or_update`, {
      headers: xhrHeaders(csrf),
      form: { utf8: '✓', authenticity_token: csrf, buy_area: area, buy_group_type_code: '',
        buy_reservation_date: dmy(date), buy_group_name: slot.id,
        buy_products: `${AREAS[area].code}_1`, multibook: 'multitickets' },
    });
    let j; try { j = JSON.parse(r.text); } catch { j = {}; }
    // The reply lists the whole cart, so only codes not seen before belong to this area.
    const found = reservationCodes(j.html).filter((c) => !cmCodes.includes(c));
    if (r.status !== 200 || !found.length || j.hold === 'ko') {
      if (cmCodes.length) {
        await http('POST', `${BASE}/${LOC}/vouchers/delete_reservations`, {
          headers: xhrHeaders(csrf), form: { utf8: '✓', authenticity_token: csrf, reservations: cmCodes.join('**'), buy_area: 'CM' },
        }).catch(() => {});
      }
      client.close();
      return null;
    }
    codes.push(...found);
    checkoutUrl = j.url || checkoutUrl;
  }

  return { client, csrf, date, cmSlot, clSlot, cmCodes, clCodes, checkoutUrl, proxyUrl };
}

async function releasePair(pair) {
  const { client, csrf } = pair;
  let ok = true;
  for (const [area, codes] of [['CM', pair.cmCodes], ['CL', pair.clCodes]]) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { http } = client;
        const r = await http('POST', `${BASE}/${LOC}/vouchers/delete_reservations`, {
          headers: xhrHeaders(csrf), form: { utf8: '✓', authenticity_token: csrf, reservations: codes.join('**'), buy_area: area },
        });
        let j; try { j = JSON.parse(r.text); } catch { j = null; }
        const gone = r.status === 200 && j !== null && !codes.some((c) => (j.html || '').includes(c));
        if (gone) break;
        if (attempt === 3) ok = false;
      } catch { if (attempt === 3) ok = false; }
      await sleep(1000);
    }
  }
  pair.client.close();
  return ok;
}

async function isHoldAlive(pair) {
  const { http } = pair.client;
  const r = await http('GET', `${BASE}/${LOC}/vouchers/checkout`);
  return r.status === 200;
}

module.exports = {
  openSession, getExcludedDays, getSlots, openDates,
  holdPair, releasePair, isHoldAlive, xhrHeaders, reservationCodes,
};
