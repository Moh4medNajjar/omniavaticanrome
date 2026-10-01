# Hold lifetime (TTL): omniavaticanrome.org

**An unpaid hold is released by the site after 15 minutes.** Measured once, on 2026-10-01, with `hold_ttl.js`.

## Result

| Time after the hold | Seats the slot offered | Event |
|---|---|---|
| before | 6 | |
| 7 s | 5 | hold placed: 1 adult Colosseo ticket, 2026-10-16 13:30, reservation `RSAB2103890P` |
| every ~37 s up to 897 s | 5 | hold alive |
| 935 s | 6 | seat back on sale (confirmed again at 949 s) |

The release happened between 897 s and 935 s after `create_or_update`, which brackets 900 s.

After the expiry:
- The holding session's `GET /it/vouchers/checkout` returned `302 → /?locale=it`, the same as an empty cart. The site clears the cart, not only the seat.
- `POST /it/vouchers/delete_reservations` for the expired code returned `200` with `{"area":"CL","html":…}` and no reservation code in the HTML.

## How it was measured

The site never shows how many seats a slot has left, but `get_availability` hides a slot from a party it cannot fit, and it honours `number_of_pax` independently of the session's own party size. Asking for 1, 2, … 7 people therefore gives the seats left in a slot (7 means "7 or more").

1. An observer session finds a Colosseo slot with 2–6 seats left.
2. A second session holds one adult ticket in that slot and then makes no further requests.
3. The observer re-counts the seats every 30 s. The count drops by one when the hold is placed and comes back when the site frees it.
4. At `--max-minutes` the script releases the hold itself.

Raw replies and the full reading series are written to `out/hold_ttl/` (not committed).

## Related findings from the same session

- **Explicit release works.** `delete_reservations` (`reservations=<codes joined by **>`, `buy_area`) frees a hold immediately. It was confirmed on a separate test cart: both codes disappeared and checkout went back to the empty-cart redirect.
- **The cart is the session.** `_omnia_session` is a 32-character session id. Setting that cookie in a browser and opening `/it/vouchers/checkout` shows the cart held by another client.

## Limits

- One run, one product part (Colosseo, area `CL`, card 10). The Carcere part and other products were not measured.
- The holding session was idle. Whether activity on the cart or checkout page resets the timer is not known.
- A stranger cancelling a seat in the same slot would look the same as the hold expiring. Landing on 900 s by coincidence is unlikely, but a repeat run would settle it.

## Re-running

```
node hold_ttl.js [--max-minutes 100] [--poll-seconds 30]
```

This holds one real seat for up to `--max-minutes`. Ctrl+C releases it before exiting.
