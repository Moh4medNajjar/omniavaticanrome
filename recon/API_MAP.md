# API / Network Map: omniavaticanrome.org booking card

Target: `https://www.omniavaticanrome.org/it/cards/carcer-tullianum-colosseo-foro-romano-e-palatino`
Captured on 2026-09-24 with headless Chromium (Playwright).

Evidence:
- `out/`: capture 1 (`capture.js`), 136 requests: page load, scroll, generic clicks.
- `out2/`: capture 2 (`capture2.js`), 381 requests over 17 step snapshots. It drives the flow: pax → multitickets → reserve → date → slot → add to cart → checkout page, then loads the EN page, another card and `/it/omnia`.
- A curl replay of the read endpoints, done in the scratchpad, confirmed the session and CSRF requirements.
- The machine-readable version of this map is `out2/map2.json`.

Each step has a `.html` and a `.png` in `out2/steps/`. Response bodies are in `out2/bodies/`. The full HAR is `out2/session.har`.

Legend: **[obs]** means observed on the wire. **[static]** means found only in JS/HTML. **[curl]** means verified by the curl replay. **(inference)** marks a conclusion not proven by the captures.

---

## 1. Summary

| Aspect | Finding | Evidence |
|---|---|---|
| Backend | **Ruby on Rails**, a classic server-rendered app. There is no JSON REST API: the XHR endpoints return **HTML fragments**, and one endpoint returns JSON that wraps HTML. | `<meta name="csrf-param" content="authenticity_token">`, `utf8=✓` hidden field, `data-disable-with`, `_omnia_session` cookie, Rails default headers (`X-Request-Id`, `X-Download-Options`, `X-Permitted-Cross-Domain-Policies`). `<body data-controller data-action>` gives the Rails controller#action (`cards#show`, `cards#multitickets`, `vouchers#checkout`, `omnia#index`, `pages#index`, `errors#not_found`). |
| Frontend | Webpacker bundle `/packs/application-ef017ba513e97208e7e8.js` (745 KB). It contains jQuery 3.7.1, jquery-validation, bootstrap-datetimepicker with moment, SweetAlert2, slick, magnific-popup, remodal and js-cookie. The app logic is jQuery `$.ajax` with delegated click handlers. | `out/bodies/23_*.js`, app code at around offset 491k–515k |
| Hosting/CDN | `Server: nginx` on the first-party origin. **No CDN or WAF headers** (no cf-ray, via or x-cache) on first-party responses. Third-party assets come from their own CDNs: Cloudflare for jsdelivr and fontawesome, BunnyCDN for iubenda. | response headers |
| Anti-bot | **Radware Bot Manager (ShieldSquare)**. An inline `SSJSConnectorObj` loads `cdn.perfdrive.com/aperture/aperture.js`, which POSTs a fingerprint to `eupulse.shieldsquare.net/jsdata` on every page. It also sets the `__uzm*` and `__ss*` cookies. A per-page inline `__uzdbm_1`/`__uzdbm_2` is embedded; `__uzdbm_2` is base64 and contains the client IP. **No reCAPTCHA, hCaptcha or Turnstile** was found. Plain curl was **not blocked** during testing. | captures; curl replay |
| Auth/session | Anonymous cookie session (`_omnia_session`: HttpOnly, SameSite=Lax, about 1 day, **not** Secure-flagged). The server keeps pax, cart and reservation holds in the session. No login or user API was seen. | cookies.json; set-cookie on every first-party response |
| CSRF | The Rails `authenticity_token` is mandatory on POST. Without it the server returns **422** [curl]. It is accepted either as the `authenticity_token` body field (what the site does) or as an `X-CSRF-Token` header [curl]. Get the token from `<meta name="csrf-token">` or from any form's hidden field; tokens are masked per render but valid for the whole session. | curl replay |
| Payments | The checkout JS switches between **PayPal** and **"Moneta"**. "Moneta" is probably Nexi/Setefi MonetaWeb (inference). No PSP domain was contacted because the pay step was not run. | bundle: `payment-check` handler, thank-you dataLayer (`checkoutOption` Paypal/Moneta) |
| Analytics | Matomo (`matomo.diocesidiroma.it`, idsite=6) and Google Tag Manager `GTM-54BZZMK`. The container references legacy `UA-141572781-1`, but **no GA/Ads hits were observed**. A GA Enhanced-Ecommerce `dataLayer` is pushed by the app. | captures, gtm.js body |
| Consent | iubenda Cookie Solution (config 65784953, TCF v2 and a CCPA stub). | captures |
| Maps | Mapbox GL JS 0.44.2 with a public `pk.` token hard-coded in the bundle (value redacted here, starts with `pk.eyJ1Ijoi…`). This card has `centered=null`, so **no tile or style requests** were made. | bundle, inline vars |

---

## 2. Request inventory

### Capture 2 (full booking flow, 381 requests)

| Host | Category | doc | xhr/ping | script | css | font | img | Total |
|---|---|---|---|---|---|---|---|---|
| www.omniavaticanrome.org | **1st-party pages/assets/XHR** | 10 | 7 | 9 | 9 | 9 | 124 | **168** |
| use.typekit.net | fonts (Adobe) | – | – | – | 9 | 54 | – | 63 |
| p.typekit.net | fonts (Adobe css/beacon) | – | – | – | 9 | – | – | 9 |
| use.fontawesome.com | icon fonts | – | – | – | 9 | 9 | – | 18 |
| api.mapbox.com | maps (lib only) | – | – | 9 | 9 | – | – | 18 |
| cdn.jsdelivr.net | CDN (promise-polyfill) | – | – | 9 | – | – | – | 9 |
| cdn.perfdrive.com | anti-bot | – | – | 8 | – | – | – | 8 |
| eupulse.shieldsquare.net | anti-bot telemetry | – | 16 | – | – | – | – | 16 |
| www.googletagmanager.com | tag manager | – | – | 9 | – | – | – | 9 |
| matomo.diocesidiroma.it | analytics | – | 9 (ping) | 9 | – | – | – | 18 |
| cdn.iubenda.com | consent | – | – | 27 | – | – | – | 27 |
| cs.iubenda.com | consent config | – | – | 9 | – | – | – | 9 |
| idb.iubenda.com | consent telemetry | – | 9 | – | – | – | – | 9 |
| **Total** | 13 hosts | | | | | | | **381** |

### Capture 1 (page load and generic clicks, 136 requests)

The same hosts appear, plus `omniavaticanrome.org` (the apex domain, 20 requests), which was reached through the promo banner link to `/it/omnia`.

- First-party dynamic requests: 0 XHR. Only 3 document loads.
- Third-party XHR/ping: ShieldSquare ×6, Matomo ×4, iubenda ×3.

Ads and third-party APIs that are only **referenced** (inside gtm.js and the iubenda core) and never contacted: `adservice.google.com`, `googleadservices.com`, `pagead2.googlesyndication.com`, `ad.doubleclick.net`, `c.amazon-adsystem.com`, `cpl.iubenda.com/big_data/consent`.

---

## 3. First-party endpoint catalogue

All paths are on `https://www.omniavaticanrome.org`. `{loc}` is `it|en|es|fr|de|pt`.

Headers that apply to every endpoint:
- The `_omnia_session` cookie. Bot-manager cookies are also sent automatically but were **not required** in the curl replay.
- POSTs need `Content-Type: application/x-www-form-urlencoded; charset=UTF-8` and an `authenticity_token`.
- XHRs send `X-Requested-With: XMLHttpRequest`, which is jQuery's default.

### 3.1 `GET /{loc}/cards/{slug}` [obs] [curl]
- **Purpose:** the product page. It includes:
  - the pax form;
  - prices;
  - `ul.products li[data-product]`, with Enhanced-Ecommerce JSON such as `{"name":…,"id":"40.04.23","price":28.0,"brand":"ORP","quantity":1}`;
  - inline `var limit_max_message…`, `centered/geojson/zoom`.
- **When:** step 1.
- **Response:** `text/html`, 200. It sets `_omnia_session`, `__uzma..__uzme` and `SL_ClassKey`.
- **Card ids:** this card is `card=10`. The related guided-visit card `/it/cards/colosseo-foro-romano-palatino-e-carcer-tullianum-visita-guidata` is `card=69`.

### 3.2 `POST /{loc}/cards/set_pax` [obs] [curl]
- **Purpose:** saves the ticket quantities and card in the session and starts the booking.
- **When:** step 2, the **"Acquista"** click. It is a full form submit, not an XHR.
- **Client-side check:** the `.add_to_cart` handler checks that `adult+child+student+newborn(+disable)` is within `[min_limit,max_limit]`. It then pushes `addToCart` to the dataLayer and submits the form.

| Param | Type | Example |
|---|---|---|
| utf8 | string | `✓` |
| authenticity_token | string | `<form token>` |
| card | int | `10` |
| locale | string | `it` |
| max_limit / min_limit | int | `7` / `0` |
| adult | int 0–10 | `1` (+18, €28) |
| child | int 0–10 | `1` (6–17, €5) |
| student | int 0–10 | `0` (EU 18–25, €7) |
| newborn | int 0–10 | `0` (0–5, free) |
| commit | string | `Acquista` |

- **Response:** `302 Location: /{loc}/cards/multitickets`.
- **Note:** the **EN** page's form posts to `/en/cards/fix_pax` [static], not `set_pax`. It was not exercised; it could be an alias or a bug.

### 3.3 `GET /{loc}/cards/multitickets` [obs] [curl]
- **Purpose:** the booking page. It has one block per **area**:
  - `CM` is Carcere Mamertino, with product codes `30.97.01` (Intero) and `30.97.02` (Ridotto).
  - `CL` is Colosseo, with `30.97.05` (Intero) and `30.97.06` (Gratuito 6/17).
- Each area has hidden `elements[]` values like `30.97.01_1` (code_qty) and a "Prenota" form posting to `/vouchers/reserve`.
- **Requires** the session state from `set_pax`.
- **Response:** `text/html`, 200.

### 3.4 `POST /{loc}/vouchers/reserve` [obs, XHR] [curl]
- **Purpose:** opens the booking widget for one area.
- **When:** step 4, the "Prenota" (`.book_area`) click. The JS collects `elements[]` and joins them with `**`.

| Param | Type | Example |
|---|---|---|
| utf8, authenticity_token | string | |
| area | enum | `CM` \| `CL` |
| buy_products | string `code_qty(**code_qty)*` | `30.97.01_1**30.97.02_1` |
| multibook | string | `multitickets` |

- **Response:** a `text/html` fragment (about 16 KB) containing:
  - `#book__datepicker`;
  - `form#checkout_get_availability` (action `/{loc}/cards/get_availability`, hidden `area`, `data`, `groups=IND`, `layout=horizontal`, `number_of_pax`);
  - `form#manage_voucher` (action `/{loc}/vouchers/create_or_update`);
  - inline `var exclude_days = ["YYYY-MM-DD", …]`, which is the list of disabled dates;
  - inline `var locale`.
- In this capture `exclude_days` disabled 25–27 Sep, 4 Oct, a few holidays, and every date from 2027-01-01 onward. The bookable window therefore ended at the end of 2026.
- **Holds:** none are created by this call (inference: no reservation code appears until `create_or_update`).

### 3.5 `POST /{loc}/cards/get_availability` [obs, XHR] [curl] — main read endpoint
- **Purpose:** returns the time slots for an area on a date.
- **When:** step 5, the datepicker `dp.change`. The date is formatted `DD-MM-YYYY`.

| Param | Type | Example |
|---|---|---|
| utf8 | string | `✓` (optional, per curl) |
| authenticity_token | string | body field **or** `X-CSRF-Token` header |
| area | enum | `CM` / `CL` |
| data | date `DD-MM-YYYY` | `28-09-2026` |
| groups | string | `IND` (individual) |
| layout | string | `horizontal` |
| number_of_pax | int | `2` |

- **Response:** a `text/html` fragment.
  - Available: about 2.5–3 KB. Structure:
    - `ul.book__groups > li.book__chose_group#group_IND` (visit type);
    - `#book__languages ul#gr_IND > li.book__chose_lang` (language; empty for this product);
    - `#book__hours ul#gr_IND > li.book__single_hour#GRP_<slotId>_<TYPE>_<YYYY-MM-DD>_<HH:MM>` (one per slot), for example `GRP_772543_IND_2026-09-28_08:30`;
    - `#book__products` with the `.book_button` "Conferma".
  - Unavailable: `<p class='u-text--center'>Non è possibile prenotare in questa data</p>` (71 B). This was observed for today's date.
  - Observed on 28-09-2026: CM had 17 slots (08:30–17:30) and CL had 11 slots (from 11:30).
- **Status codes:**
  - 200;
  - **404** when there is no `set_pax` session state [curl];
  - **422** when the CSRF token is missing [curl].
- **Prices:** none are returned here. Prices come only from the card page (`data-product`, labels) and the checkout page.

### 3.6 `POST /{loc}/vouchers/create_or_update` [obs, XHR] — ⚠ creates reservation holds
- **Purpose:** holds the selected slot and adds it to the cart.
- **When:** step 6. It is triggered by "Conferma" (`.book_button`), and also by `.buy_button` or `.hold_button` in other layouts.

| Param | Type | Example |
|---|---|---|
| utf8, authenticity_token | string | |
| buy_area | enum | `CM` |
| buy_group_type_code | string | empty for IND |
| buy_reservation_date | `DD-MM-YYYY` | `28-09-2026` |
| buy_group_name | slot id | `GRP_772543_IND_2026-09-28_08:30` |
| buy_products | string | `30.97.01_1**30.97.02_1` |
| multibook | string | `multitickets` |

- **Response:** `application/json`, 200, with shape `{ "area": "CM", "html": "<re-rendered area block>", "url": null | "<next url>" }`.
  - `html` contains the reservation codes (for example `RSAB2097331T`) and a `form#delete_reservation` (`reservations=RSAB…**RSAB…`, `buy_area`).
  - Once every area is booked, `url` is set and the JS navigates to it (observed: `/it/vouchers/checkout`).
  - According to the JS, the `.buy_button` path can also return `{hold:"ko"}`, which shows `alert_ko_hold_reservations_message`.

### 3.7 `GET /{loc}/vouchers/checkout` [obs]
- **Purpose:** the cart plus the personal-data form. It is reachable from the header cart icon (`span.items` shows the count).
- **Response:** `text/html`, 200. With an empty session it returns `302 → /?locale=it → 302 /it`, as seen in capture 1.
- **Content:**
  - lines with commercial codes (`40.04.23` Intero €28, `40.04.09` Ridotto €5) and child reservations per area;
  - `form[action=/{loc}/vouchers/delete_item]` (`code`, `qta`);
  - `form#form-checkout` → `POST /{loc}/vouchers/pay`.
- **Flow stopped here.** No data was entered.

### 3.8 Endpoints found only in code or HTML (not called)

| Method | Path | Params / response | Source |
|---|---|---|---|
| GET | `/check_valid_products?buy_products=<codes>` | JSON `{"status":"ok"}` [curl]. Used by `.buy_button` before `create_or_update`. Not under a locale prefix: `/it/check_valid_products` returns 404 [curl]. | bundle |
| POST (XHR) | `/{loc}/vouchers/delete_reservations` | `reservations=RSAB…**RSAB…`, `buy_area`. JSON `{area, html}`. This is the "Modifica" button. | create_or_update HTML, bundle `.delete_reservation` |
| POST | `/{loc}/vouchers/delete_item` | `code`, `qta`. Form submit. | checkout HTML |
| POST | `/{loc}/vouchers/pay` | `voucher_valid`, `voucher_amount`, `nome`, `cognome`, `nazionalita`, `email`, `tel` (6–14 digits), `promo_code`, `informativa`, `informativa2`, `informativa3`. Then PayPal/"Moneta". **Not exercised.** | checkout HTML, bundle `#form-checkout.validate` |
| POST | `/en/cards/fix_pax` | same fields as set_pax | EN card HTML |
| GET | `/change-language?l=<lang>&locale=<cur>` | [obs] returned **404** (`errors#not_found`). Direct `/en/...` URLs work. | header nav |
| GET | `a.gallery-popup[href]` | HTML fragment injected into `#gallery` | bundle |
| POST (XHR) | `form#load_products[action]` | `elements[]=code_qty` for the +/- quantity controls. Returns HTML (`.products_box`). Not rendered on this card. | bundle `.plus/.minus` |
| POST (XHR) | `form#load_supplements[action]`, `.reserve_supplement[href]`, `.add_supplement[href]` | supplements. Returns HTML, or JSON `{url}`. Uses `window.supplements`. | bundle |
| – | `vouchers#thankyoupage` | reads `#voucher[data-voucher]` and `data-payment` (`PAYPAL` or other) to push the `purchase` event | bundle |
| GET | `/it/newsletters/new`, `/it/contacts/new`, `/it/pages/*`, `/it/partners` | ordinary pages | nav HTML |
| GET | `/{loc}/cards/omnia-card-72h`, `omnia-card-24h`, `omnia-smart`, `/it/omnia` | Omnia pass pages. `.buy_without_reservation` pushes checkout step 2. | nav HTML, bundle |

### Third-party request details

| Method | URL | Purpose | Body / response |
|---|---|---|---|
| POST | `https://eupulse.shieldsquare.net/jsdata` | bot fingerprint (2 per page) | form: `cid=cidd`, `url`, `JSinfo={j0..j290}` (UA, screen, WebGL, headless flags…), `__uzmaj/bj/cj/dj`, `et=82`. Response `text/plain` JSON `{ssresp:"0", jsrecvd:"true", __uzmaj.., jsbd2}`. |
| POST (beacon) | `https://matomo.diocesidiroma.it/matomo.php` | pageview/link | query: `action_name, idsite=6, rec, url, urlref, _id, pv_id, pf_*`, `uadata`. 204. |
| POST | `https://idb.iubenda.com/csdata?db=hits1` | consent hit | `hits,cp=65784953,...`. 204. |
| GET | `https://www.googletagmanager.com/gtm.js?id=GTM-54BZZMK` | GTM | tags `__html`, `__lcl` etc. The only analytics ID found is UA-141572781-1. |

---

## 4. Booking flow sequence

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant S as www.omniavaticanrome.org (Rails/nginx)
    participant R as ShieldSquare (perfdrive / eupulse)
    participant T as Matomo / GTM / iubenda
    B->>S: GET /it/cards/{slug}
    S-->>B: 200 HTML (csrf meta, pax form, data-product) + Set-Cookie _omnia_session, __uzm*
    B->>R: GET aperture.js ; POST /jsdata x2 (fingerprint)
    B->>T: gtm.js, matomo.js, POST matomo.php, iubenda scripts, POST csdata
    Note over B: choose adult/child/student/newborn, click "Acquista"
    B->>S: POST /it/cards/set_pax (form, authenticity_token, card, pax)
    S-->>B: 302 → /it/cards/multitickets
    B->>S: GET /it/cards/multitickets
    S-->>B: 200 HTML (areas CM & CL, elements[] code_qty)
    loop per area (CM then CL)
        B->>S: POST /it/vouchers/reserve (XHR: area, buy_products)
        S-->>B: 200 HTML fragment (datepicker, exclude_days, forms)
        B->>S: POST /it/cards/get_availability (XHR: area, data=DD-MM-YYYY, groups=IND, number_of_pax)
        S-->>B: 200 HTML slots (li.book__single_hour#GRP_id_IND_date_time) or "Non è possibile prenotare"
        Note over B: click group → language → hour (client-side only)
        B->>S: POST /it/vouchers/create_or_update (XHR: buy_area, buy_reservation_date, buy_group_name, buy_products)
        S-->>B: 200 JSON {area, html(with RSAB… hold codes), url}
    end
    Note over B,S: (alt path .buy_button) GET /check_valid_products → {"status":"ok"} before create_or_update
    B->>S: GET /it/vouchers/checkout (url from last JSON)
    S-->>B: 200 HTML cart + form#form-checkout
    Note over B,S: STOP. Not executed: POST /it/vouchers/pay → PayPal / "Moneta" → vouchers#thankyoupage
```

The GA Enhanced-Ecommerce dataLayer events fire in this order:
1. `productImpressions` and `productDetail` on the card page;
2. `addToCart` on Acquista and on each `create_or_update` that returns a url;
3. `checkout` step 1 "Book Calendar", step 2 "Omnia senza prenotazioni" and step 4 "Update Customer";
4. `checkoutOption` (5 Moneta / 6 Paypal);
5. `purchase` on the thank-you page;
6. `productClick` and `removeFromCart` fire when the user clicks a product card or removes a cart line.

---

## 5. Cookies and storage

| Cookie | Set by | Scope / flags | Lifetime | Role |
|---|---|---|---|---|
| `_omnia_session` | first-party Set-Cookie (every response) | www, HttpOnly, Lax, **not Secure** | about 1 day | Rails session: pax, cart, reservation holds. **Required** for get_availability, reserve and checkout. |
| `__uzma`, `__uzmb`, `__uzmc`, `__uzmd`, `__uzme` | first-party Set-Cookie (ShieldSquare server connector) | www, HttpOnly, Lax | about 6 months | bot manager: visitor id (uuid), first-seen timestamp, counters. `__uzmc`/`__uzmd` are refreshed on every request. |
| `__uzmaj2`, `__uzmbj2`, `__uzmcj2`, `__uzmdj2`, `__ssds`, `__ssuzjsr2` | aperture.js | .omniavaticanrome.org | about 6 months | JS-side copies of the bot-manager ids |
| `SL_ClassKey` | first-party Set-Cookie on first hit | www | 2 days | value `0.1.1`. Purpose unknown, possibly a traffic class or load-balancer key (inference). |
| `_pk_id.6.32d3`, `_pk_ses.6.32d3` | matomo.js | .www | 13 months / 30 min | Matomo visitor and session |
| `_iub_cs-65784953`, `_iub_cs-35810162`, `usprivacy` | iubenda | .omniavaticanrome.org, Secure, SameSite=None | 1 year | consent state (TCF/CCPA) |
| `alert_window` | app JS (js-cookie) | path `/` | 1 day | remembers a dismissed promo banner or modal (`#banner[data-id]`). Referenced in code. |

- localStorage and sessionStorage were both **empty** at the end of both captures.
- Global JS state used by the flow: `window.exclude_days`, `locale`, `supplements`, `limit_*_message`, `alert_*_message`, `no_qta_*`, `lock_message`, `btn_ok`, `btn_cancel`, `centered`, `geojson`, `bus_stop_json`, `zoom`.

---

## 6. Reproducible curl (read-only: availability)

`get_availability` returns 404 unless the session has first been through `set_pax`. `set_pax` only stores quantities; it does not hold any inventory. Every command below was verified to return 200 on 2026-09-24.

```bash
B=https://www.omniavaticanrome.org
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
JAR=jar.txt

# 1) card page -> session cookie + form token
curl -s -A "$UA" -c $JAR -b $JAR -o card.html "$B/it/cards/carcer-tullianum-colosseo-foro-romano-e-palatino"
FORM_TOKEN=$(grep -o 'name="authenticity_token" value="[^"]*"' card.html | head -1 | sed 's/.*value="//;s/"$//')

# 2) set pax (1 adult, 1 child) -> 302 to /it/cards/multitickets
curl -s -A "$UA" -c $JAR -b $JAR -o /dev/null -w '%{http_code}\n' \
  --data-urlencode "authenticity_token=$FORM_TOKEN" \
  --data 'utf8=%E2%9C%93&card=10&locale=it&max_limit=7&min_limit=0&adult=1&child=1&student=0&newborn=0' \
  "$B/it/cards/set_pax"

# 3) multitickets page -> fresh CSRF token
curl -s -A "$UA" -c $JAR -b $JAR -o mt.html "$B/it/cards/multitickets"
CSRF=$(grep -o 'name="csrf-token" content="[^"]*"' mt.html | sed 's/.*content="//;s/"$//')

# 4) availability (area CM or CL, date DD-MM-YYYY) -> HTML with li.book__single_hour
curl -s -A "$UA" -c $JAR -b $JAR \
  -H 'X-Requested-With: XMLHttpRequest' -H "X-CSRF-Token: $CSRF" \
  --data 'area=CM&data=28-09-2026&groups=IND&layout=horizontal&number_of_pax=2' \
  "$B/it/cards/get_availability" -o slots_CM.html
grep -o "id='GRP_[^']*'" slots_CM.html     # slot ids: GRP_<id>_IND_<date>_<HH:MM>

# 5) (optional) booking widget with disabled dates (exclude_days) - no hold is created
curl -s -A "$UA" -c $JAR -b $JAR -H 'X-Requested-With: XMLHttpRequest' \
  --data-urlencode "authenticity_token=$CSRF" \
  --data 'area=CM&buy_products=30.97.01_1**30.97.02_1&multibook=multitickets' \
  "$B/it/vouchers/reserve" -o widget_CM.html

# 6) product-combination check (JSON)
curl -s -A "$UA" -b $JAR "$B/check_valid_products?buy_products=30.97.01_1**30.97.02_1"   # {"status":"ok"}
```

Prices are not exposed by any XHR. Read them from the card page:

```bash
grep -o "data-product=\"[^\"]*\"" card.html | sed 's/&quot;/"/g'
# -> {"name":"… Intero + 18 anni","id":"40.04.23","price":28.0,"brand":"ORP","quantity":1} …
```

Placeholders: `$FORM_TOKEN` and `$CSRF` are per-session Rails tokens, and the cookie jar holds `_omnia_session`. Do **not** call `create_or_update` in scripts: it places real reservation holds.

---

## 7. Gaps and unknowns

1. **Payment was not exercised** (intended). The `/vouchers/pay` response, PSP redirect domains (PayPal, "Moneta"/Nexi, the latter inferred), callback and return URLs, and the `vouchers#thankyoupage` route path are all unknown.
2. **Side effect of capture 2:** it placed **4 temporary reservation holds**, codes RSAB2097331T–RSAB2097334C, for 28-09-2026 in an abandoned session. A later test (2026-10-01) measured the hold lifetime: the site releases an unpaid hold after 15 minutes, see `HOLD_TTL.md`. Re-run with `NO_HOLD=1` to skip the add-to-cart step.
3. `/en/cards/fix_pax` (the EN form action, versus `set_pax` in IT) was not exercised. `/change-language?...` returned 404, so the language switcher appears broken.
4. Some branches were not reached on this product: guided-visit groups and languages (card 69), `load_products` and `load_supplements` +/- endpoints, supplements (`window.supplements` was `{}`), and Omnia pass purchase without reservation. Their form actions are rendered server-side and do not appear in the captured HTML.
5. The iubenda "accept" button was not matched, so consent was never explicitly granted. Consent-gated GTM tags (Ads/GA) may therefore be missing. GTM only references the legacy UA-141572781-1, and no Google collect hits were seen.
6. Whether get_availability depends only on `set_pax` or also on the card/area mapping for other cards was not tested (inference: `area` must belong to the session's card).
7. The 11:30 start of CL slots, and whether the "Colosseo ≥1h after Carcere" rule is enforced server-side or only described in text, were not confirmed.
8. ShieldSquare did not block curl or headless Chromium at this volume. Its behaviour under higher request rates was not tested.
