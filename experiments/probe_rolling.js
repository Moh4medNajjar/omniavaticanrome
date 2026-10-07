// Rolling renewal: a cart made of several 1-ticket batches (Colosseo + Carcere each).
// Renew ONE batch at a time inside the same session: release that batch's two codes,
// book 1 Colosseo + 1 Carcere again, check the cart. The other batches stay held, so at
// most one seat is ever free. Needs a slot with at least BATCHES free seats.
const { makeClient, sleep, dmy, BASE, LOC, AREAS, CARD_ID } = require('../lib/client');
const { openSession, getSlots, xhrHeaders, reservationCodes } = require('../lib/site');

const [date = '2026-10-15', clTime = '17:00', batches = '3'] = process.argv.slice(2);
const N = Number(batches);
const ts = () => new Date().toISOString().slice(11, 23);
const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

(async () => {
  const c = makeClient(null);
  const { csrf } = await openSession(c, { adults: 1 });
  const cl = (await getSlots(c, csrf, 'CL', date, 0)).find((s) => s.time === clTime);
  const cm = (await getSlots(c, csrf, 'CM', date, 7)).filter((s) => s.time <= String(Number(clTime.slice(0, 2)) - 1).padStart(2, '0') + clTime.slice(2)).pop();
  const post = (path, form, xhr = true) => c.http('POST', `${BASE}/${LOC}${path}`, xhr ? { headers: xhrHeaders(csrf), form } : { form });
  const shoot = async (area, slot) => reservationCodes(JSON.parse((await post('/vouchers/create_or_update', { buy_area: area, buy_reservation_date: dmy(date), buy_group_name: slot.id, buy_products: `${AREAS[area].code}_1`, multibook: 'multitickets' })).text).html);
  const setPax = () => post('/cards/set_pax', { utf8: '✓', authenticity_token: csrf, card: CARD_ID, locale: LOC, max_limit: 7, min_limit: 0, adult: 1, child: 0, student: 0, newborn: 0, commit: 'Acquista' }, false);
  const del = (codes) => Promise.all(['CL', 'CM'].map((area) => post('/vouchers/delete_reservations', { reservations: codes.join('**'), buy_area: area })));
  const cart = async () => {
    const r = await c.http('GET', `${BASE}/${LOC}/vouchers/checkout`);
    const t = strip(r.text);
    const lines = (t.match(/\d+\s+persona\/e/g) || []);
    return { status: r.status, lines: lines.join(' + '), people: lines.reduce((a, l) => a + Number(l.split(' ')[0]), 0), codes: [...new Set(r.text.match(/\bRS[A-Z]{2}\d{6,}[A-Z]\b/g) || [])], total: (t.match(/Totale:\s*([\d.,]+)/) || [])[1] };
  };
  const show = async (label) => { const x = await cart(); console.log(`${ts()} ${label}: ${x.status} | lines ${x.lines} | ${x.codes.length} codes | ${x.total} €`); return x; };

  const groups = []; // codes of each batch
  try {
    for (let b = 0; b < N; b++) {
      if (b) await setPax();
      // READ_EMPTY=1 reproduces the original test: the cart page is read before the
      // first batch, while the cart has nothing booked yet.
      const before = b === 0 && process.env.READ_EMPTY !== '1' ? [] : (await cart()).codes;
      await shoot('CL', cl); await shoot('CM', cm);
      const snap = await cart();
      console.log(`${ts()}   after batch ${b + 1}: lines ${snap.lines} | ${snap.codes.length} codes | ${snap.total} €`);
      const after = snap.codes;
      groups.push(after.filter((x) => !before.includes(x)));
    }
    await show(`built ${N} batches of 1`);
    console.log(`${ts()} batches: ${groups.map((g) => g.join('+')).join(' | ')}`);

    for (let round = 1; round <= 2; round++) {
      for (let b = 0; b < N; b++) {
        const old = groups[b];
        const t0 = Date.now();
        await del(old);
        const tRel = Date.now() - t0;
        const clCodes = await shoot('CL', cl);
        const tBack = Date.now() - t0;
        await shoot('CM', cm);
        const now = await cart();
        const others = groups.filter((_, i) => i !== b).flat();
        const fresh = now.codes.filter((x) => !others.includes(x) && !old.includes(x));
        const ok = fresh.length === 2 && others.every((x) => now.codes.includes(x));
        console.log(`${ts()} round ${round} batch ${b + 1}: release ${tRel}ms, Colosseo back at ${tBack}ms (reply codes ${clCodes.length}) | cart lines ${now.lines}, ${now.codes.length} codes, ${now.total} € | ${ok ? 'OK' : 'NOT OK'}`);
        if (!ok) { console.log(`${ts()} codes now: ${now.codes.join(',')}`); throw new Error('rolling renewal broke the cart'); }
        groups[b] = fresh;
        await sleep(1000);
      }
    }
    console.log(`${ts()} RESULT: rolling renewal works`);
  } catch (e) {
    console.log(`${ts()} RESULT: ${e.message}`);
  } finally {
    const left = (await cart()).codes;
    if (left.length) await del(left);
    await show('released everything');
    c.close();
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
