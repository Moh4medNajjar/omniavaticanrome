# Booking Flow Endpoints

## Session Setup (required once)
1. `GET /it/cards/carcer-tullianum-colosseo-foro-romano-e-palatino` → session cookie + `authenticity_token`
2. `POST /it/cards/set_pax` → sets party size (adult, child, etc.)
3. `GET /it/cards/multitickets` → `csrf-token` for XHR calls

## Calendar (cache once, refresh on demand)
4. `POST /it/vouchers/reserve` → returns `exclude_days[]` (blocked dates)
   - Called per area (CM, CL)
   - Response is HTML with embedded JS: `var exclude_days = [...]`

## Slot Discovery (cache once per date)
5. `POST /it/cards/get_availability` → returns slot IDs for a date+area
   - Params: `area`, `data` (DD-MM-YYYY), `groups: IND`, `layout: horizontal`, `number_of_pax`
   - Response: HTML with slot elements: `id='GRP_792967_IND_2026-10-14_09:30'`
   - **GRP numbers are database IDs — CANNOT be guessed, must be fetched**
   - GRP numbers are stable per slot (same across sessions)

## Add to Cart (the fast path — hammer this)
6. `POST /it/vouchers/create_or_update` → attempts to reserve a slot
   - Params: `buy_area`, `buy_reservation_date` (DD-MM-YYYY), `buy_group_name` (full slot ID), `buy_products` (`code_qty`), `multibook`
   - **SUCCESS**: status 200, `html` has a hidden input `reservations` holding the codes → tickets held
   - **FAILURE**: status 200, `html` has no `reservations` input → slot full, or the slot id does not exist (same reply)
   - **BLOCKED**: `hold: 'ko'` → anti-hoarding kicked in
   - 0.6–0.9 s per call when the site is idle; see "Measured behaviour" for what the reply really means

## Release
7. `POST /it/vouchers/delete_reservations` → releases held tickets
   - Params: `reservations` (codes joined with `**`), `buy_area`

## Hold Check
8. `GET /it/vouchers/checkout` → 200 = cart alive, 302 = cart empty (hold dropped)

## Measured behaviour (2026-10-05)

Each line was measured against the live site with the scripts in `experiments/`. `sniper.js` is built on these.

- **Hold lifetime is fixed at 15 min.** Re-sending `create_or_update` in the holding session at minute 10 returned the same code, and the cart was gone at minute 16 (`probe_ttl_refresh.js`). Nothing extends a hold: keeping seats means releasing them and catching them again.
- **A cart cannot be changed in place.** Once the session holds a reservation for an area, further `create_or_update` calls for that area change nothing and the reply repeats the existing code (`probe_ratchet.js`). Holds are all-or-nothing: asking for 7 when fewer are free returns no code.
- **The reply lists the whole cart**, so a CL reply repeats the CM code and the other way round. A hold on both areas means two distinct codes.
- **Read codes only from the `reservations` hidden input** (`value="RSAB…**RSAB…"`). The reply also carries four random 88-character security tokens, and the loose pattern `RS[A-Z]{2}\d+[A-Z]` matches inside them about once per 1,000 replies (`probe_code_markup.js`; `probe_concurrency.js` "caught" `RSPM5A` that way).
- **A request that fails can still create the hold.** One `create_or_update` returned HTTP 500 after 4.8 s with an empty body and took the 2 seats anyway.
- **The session party size (`set_pax`) must equal the ticket count.** With pax 7 and a request for 1 ticket, the reply had a code but the cart was empty.
- **`number_of_pax=0` lists every slot of a day**, full ones included (18 CL slots, against 3 with pax 1). Days in `exclude_days` still list their slots; days outside the sales window list none. Asking with pax 1…7 gives the seats left (`probe_pax0.js`).
- **A full slot and a nonexistent slot id give the same reply.** There is no "full" message.
- **The endpoint serves about 2 requests per second in total, for all visitors.** 1 loop got 1.3/s at 0.9 s per request, 3 in parallel got 2.0/s at 1.7 s, 6 got 2.3/s at 2.5 s (up to 4.8 s), and meanwhile a client on another IP slowed from 0.7 s to 5 s (`probe_concurrency.js`). Parallel requests beyond about 3 add no tries and slow the site for every visitor.
- **Checkout page** (`GET /vouchers/checkout`: 200 with a cart, 302 when empty) lists the reservation codes, the people count (`40.04.23 N persona/e`) and `Totale`. A rejected pay form redirects back to `/it/vouchers/checkout`.
- **Wire size:** one `create_or_update` is about 3.3 KB with gzip (1.3 KB body and 1 KB headers down, 0.8 KB up). Opening a session is about 22 KB.

## Strategy used by sniper.js
- Slot ids come from step 5 with `number_of_pax=0`, so any time of any listed day can be targeted.
- Step 6 is repeated for the Colosseo slot until a reply carries a code, then once for the Carcere slot in the same session, then the checkout page confirms the cart.
- At most 3 requests are in flight across all hunts (see the capacity line above).
- Every 13 min a held cart is released and re-caught from fresh sessions.

## Slot ID Format
```
GRP_{db_id}_IND_{YYYY-MM-DD}_{HH:MM}
```
Examples:
- `GRP_792967_IND_2026-10-14_09:30` (CL, Oct 14)
- `GRP_793027_IND_2026-10-15_09:30` (CL, Oct 15)
- GRP numbers increment roughly +3 to +9 between time slots
- Different dates have different GRP number ranges
