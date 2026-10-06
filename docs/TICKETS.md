# Ticket types and scarcity: omniavaticanrome.org

Live probe of 2026-10-01 (about 20:20–20:40 UTC) with `scarcity.js`. The raw result is `out/scarcity.json`. The probe is read-only: it never holds a ticket.

The site lists 60 products ("cards"). Card URLs are `https://www.omniavaticanrome.org/it/cards/<slug>`; slugs are the keys of `out/scarcity.json`.

## How to read this

- **Open days** are days the booking calendar lets you pick, counted over the next 30 and 120 days. Every calendar currently ends on 30 or 31 December 2026; nothing for 2027 is on sale.
- **Slots** are the time slots offered for one person on eight sampled days per area. The site does not expose how many seats a slot has left, so a slot count is not a seat count.
- For products with several areas (for example Carcere + Colosseo), the rating follows the tightest area.
- **Sold out / no dates** means the calendar has no bookable day at all. The site does not say whether the dates were sold or never published.

| Rating | Rule |
|---|---|
| Sold out / no dates | 0 open days in 120 |
| Very high | 10 or fewer open days in 120 |
| High | 5 or fewer open days in the next 30 |
| Medium | 6–15 open days in the next 30 |
| Low | more than 15 open days in the next 30 |
| No date booking | bought without picking a date, so no calendar to run out |
| Not sold online | the card page has no purchase form ("Al momento questa attività non è acquistabile online") |

## Notes on specific products

- **St. Peter's Basilica guided visits (areas SP of cards 6, 120, 123):** no bookable day in the calendar's whole range. On 2026-09-26 card 123 still had 3 open days, so those went since.
- **St. Peter's Necropolis (cards 132, 135):** nothing in October; the first open day is 2026-11-03, with one or two slots per day.
- **Vatican Museums (area MV of cards 109, 120):** 2 open days in the next 30. The guided Museums visit (card 36) has 10. The Omnia cards use a different Museums allocation (area MVO) and are open on 25 of the next 30 days.
- **Colosseum (area CL of cards 10, 82, 107):** 2–4 October are closed and 5–6 October have only 4–5 slots, against 14–18 on later days. Near dates sell down; later dates are plentiful.
- **Colosseum Arena (area OAC of card 108):** every day is open, but the next few days have only 1–2 slots, against 6 later.
- **€10 themed walks (cards 27, 45, 46, 75, 76, 83, 126, 138, 143, 146, 149):** these look like occasional scheduled events. Most have no date published; two have a single date.

## All products

| Product | Card id | Tiers | Scarcity | Evidence |
|---|---|---|---|---|
| Da Betlemme a Roma: visita ai Presepi | 45 | +18 anni (€10,00); 6 - 17 anni (€ 5,00) | **Sold out / no dates** | area ITP: 0 open days in 120 |
| Eredità dei culti antichi nella Roma di oggi | 143 | +18 anni (€ 10,00); 6 - 17 anni (€ 5,00) | **Sold out / no dates** | area AR0005i: 0 open days in 120 |
| I grandi Santi a Roma | 83 | +18 anni (€10,00); 6 - 17 anni (€5,00) | **Sold out / no dates** | area GSR: 0 open days in 120 |
| Icone Mariane Miracolose | 27 | +18 anni (€10,00); 6 - 17 anni (€ 5,00) | **Sold out / no dates** | area ITM: 0 open days in 120 |
| Il Sacro Cuore di Gesù a Roma | 76 | +18 anni (€10,00); 6 - 17 anni (€5,00) | **Sold out / no dates** | area ISC: 0 open days in 120 |
| La Bellezza della Fede: dal cuore di San Pietro ai Musei Vaticani | 120 | Intero +18 anni (€ 65,00); 6 - 17 anni (€ 40,00) | **Sold out / no dates** | area SP: 0 open days in 120 |
| Le Botteghe storiche del centro di Roma | 46 | Adulto +18 anni; 6 - 17 anni | **Sold out / no dates** | area AR0005e: 0 open days in 120 |
| Le Grandi Sante a Roma | 138 | +18 anni (€ 10,00); 6 - 17 anni (€ 5,00) | **Sold out / no dates** | area ISD: 0 open days in 120 |
| Le Madonnelle di Roma | 75 | +18 anni (€ 10,00); 6 - 17 anni (€ 5,00) | **Sold out / no dates** | area MADR: 0 open days in 120 |
| Le Radici del Martirio: Basilica di San Pietro, Carcere e Gloria | 123 | +18 anni (€ 39,00); 6 - 17 anni (€ 29,00) | **Sold out / no dates** | area SP: 0 open days in 120 |
| Roma Missionaria | 126 | +18 anni (€ 10,00); 6 - 17 anni (€ 5,00) | **Sold out / no dates** | area 001: 0 open days in 120 |
| Visita guidata ufficiale della Basilica di San Pietro | 6 | Intero +18 anni (€ 26,00); 6 - 17 anni (€ 19,00) | **Sold out / no dates** | area SP: 0 open days in 120 |
| Colosseo, Foro Romano, Palatino e Carcere Mamertino - Visita guidata | 69 | + 18 anni (€ 51,00); 6 - 17 anni (€ 29,00); Studenti UE 18 - 25 anni (€ 31,00); Gratuito 0 - 5 anni (€ 0,00) | **Very high** | 5/30 and 6/120 days open, first 2026-10-05, 1 slot per sampled day |
| Santi e Santità nel Rinascimento Romano | 146 | Adulti; 6-17 anni | **Very high** | 1/30 and 1/120 days open, first 2026-10-17, 1 slot per sampled day |
| Urbanistica Romana dei Pellegrini: Sisto V e gli Obelischi | 149 | +18 anni (€ 10,00); 6 - 17 anni (€ 5,00) | **Very high** | 0/30 and 1/120 days open, first 2026-11-14, 1 slot per sampled day |
| Musei Vaticani, Cappella Sistina e Carcere Mamertino | 109 | Intero +18 anni (€ 40,00); 6 - 17 anni e cittadini studenti UE 18 -25 anni (€ 27,00) | **High** | 2/30 and 34/120 days open, first 2026-10-12, 1 slot per sampled day |
| Visita della Necropoli di San Pietro e della Basilica Vaticana | 132 | +18 anni (€ 37,00); 10 - 17 anni (€ 27,00) | **High** | 0/30 and 35/120 days open, first 2026-11-03, 1–2 slots per sampled day |
| Visita guidata della Necropoli di San Pietro | 135 | +18 anni (€ 29,00); 10 - 17 anni (€ 19,00) | **High** | 0/30 and 35/120 days open, first 2026-11-03, 1–2 slots per sampled day |
| Da San Giovanni a San Pietro, la Chiesa in cammino | 115 | +18 anni (€ 95,00); 6 - 17 anni (€ 60,00) | Medium | 12/30 and 47/120 days open, first 2026-10-02, 1 slot per sampled day |
| Visita guidata dei Musei Vaticani e della Cappella Sistina | 36 | +18 anni (€ 60,00); 6 - 17 anni e std 18-25 anni (€ 45,00) | Medium | 10/30 and 50/120 days open, first 2026-10-02, 1 slot per sampled day |
| Basilica di San Pietro con audioguida e salita alla Cupola | 129 | +18 anni (€ 29,00); 6 - 17 anni (€ 22,00) | Low | 25/30 and 73/120 days open, first 2026-10-02, 1 slot per sampled day |
| Basilica di Santa Maria Maggiore: Ingresso con accompagnatore e audioguida multilingue | 91 | +18 anni (€ 15,00); 6 - 17 anni (€ 12,00) | Low | 29/30 and 88/120 days open, first 2026-10-02, 1 slot per sampled day |
| Carcere Mamertino + 24h Only Arena del Colosseo | 108 | + 18 anni (€ 28,00); 6 - 17 anni (€ 5,00); 18 - 25 anni compiuti* (€ 7,00); Gratuito 0/5 anni (€ 0,00) | Low | tightest area CM: 28/30 and 86/120 days open, first 2026-10-02, 14–18 slots per sampled day |
| Carcere Mamertino, Colosseo, Foro Romano e Palatino | 10 | +18 anni (€ 28,00); 6 - 17 anni (€ 5,00); 18 - 25 anni compiuti* (€ 7,00); Gratuito 0 - 5 anni (€ 0,00) | Low | tightest area CL: 26/30 and 84/120 days open, first 2026-10-05, 4–18 slots per sampled day |
| Carcere Mamertino, Colosseo, Foro Romano, Palatino e audioguida | 82 | + 18 anni (€ 34,00); 6 - 17 anni (€ 10,00); 18 - 25 anni compiuti* (€ 12,00); Gratuito 0 - 5 anni (€ 0,00) | Low | tightest area CL: 26/30 and 84/120 days open, first 2026-10-05, 4–18 slots per sampled day |
| Carcere Mamertino, Foro Romano, Palatino SUPER | 21 | Intero +25 anni (€ 28,00); 6 - 17anni (€ 7,00); 18 - 25 anni compiuti* (€ 9,00); Gratuito 0 - 5anni(€ 0,00) | Low | 28/30 and 86/120 days open, first 2026-10-02, 14–18 slots per sampled day |
| Catacombe dei Santi Marcellino e Pietro e Mausoleo di Sant'Elena | 32 | +17 anni (€ 15,00); 7 - 16 anni (€ 12,00) | Low | 25/30 and 77/120 days open, first 2026-10-02, 2–6 slots per sampled day |
| Chiesa di Sant'Agnese in Agone e Cripta - Ingresso Accompagnato | 93 | +6 anni (€ 5,00) | Low | 21/30 and 61/120 days open, first 2026-10-02, 13 slots per sampled day |
| Il Carcere Mamertino | 7 | Intero +18anni (€ 10,00); 6 - 17anni e std fino a 25anni UE (€ 5,00) | Low | 29/30 and 88/120 days open, first 2026-10-02, 1 slot per sampled day |
| Il Palazzo Lateranense: La Casa del Vescovo di Roma - Ingresso con audioguida | 95 | +18 anni (€14,00); 6 - 17 anni (€12,00); Studenti UE 18 - 25 anni (€12,00) | Low | 21/30 and 60/120 days open, first 2026-10-02, 2 slots per sampled day |
| Il Palazzo Lateranense: La Casa del Vescovo di Roma - Visita Guidata | 88 | +18 anni (€18,00); 6 - 17 anni (€14,00); Studenti UE 18 - 25 anni (€14,00) | Low | 21/30 and 57/120 days open, first 2026-10-02, 1 slot per sampled day |
| Le Catacombe di Domitilla | 19 | +17 anni (€ 12,00); 7-16 anni (€ 9,00) | Low | 25/30 and 70/120 days open, first 2026-10-02, 4 slots per sampled day |
| Le Catacombe di Priscilla | 33 | +17 anni (€ 12,00); 7 - 16 anni (€ 9,00); *Gratuito | Low | 25/30 and 73/120 days open, first 2026-10-02, 6–10 slots per sampled day |
| Le Catacombe di San Callisto | 9 | +17 anni (€ 12,00); 7 -16 anni (€ 9,00) | Low | 25/30 and 77/120 days open, first 2026-10-02, 39–42 slots per sampled day |
| Le Catacombe di San Sebastiano | 18 | +17 anni (€ 12,00); 7 - 16 anni (€ 9,00) | Low | 25/30 and 57/120 days open, first 2026-10-02, 23–33 slots per sampled day |
| Le Catacombe di Sant'Agnese | 31 | +17 anni (€ 12,00); 7 - 16 anni (€ 9,00) | Low | 24/30 and 57/120 days open, first 2026-10-02, 2–5 slots per sampled day |
| Luoghi di fede, tempo della Chiesa | 112 | Intero + 6 anni (€ 25,00) | Low | 21/30 and 60/120 days open, first 2026-10-02, 1 slot per sampled day |
| OMNIA Card 24H | 16 | +18 anni (€ 69,00); 6 - 17 anni (€ 49,00) | Low | 25/30 and 73/120 days open, first 2026-10-02, 3–6 slots per sampled day |
| OMNIA Card 72H | 5 | +18 anni (€ 149,00); 6 - 17 anni (€ 69,00) | Low | 25/30 and 73/120 days open, first 2026-10-02, 3–6 slots per sampled day |
| OMNIA Smart | 107 | +18 anni (€ 99,00); 6 - 17 anni (€ 57,00); Studente UE 18-25 anni* (€ 59,00) | Low | tightest area PLT: 21/30 and 60/120 days open, first 2026-10-02, 2 slots per sampled day |
| Palazzo Lateranense e Catacombe di San Sebastiano | 59 | +18 anni (€ 22,00); 7- 16 anni (€ 17,00) | Low | tightest area DS: 25/30 and 57/120 days open, first 2026-10-02, 23–33 slots per sampled day |
| Visita con audioguida del Palazzo Lateranense con Chiostro e Basilica di San Giovanni | 51 | + 18 anni (€ 19,00); 6 - 17 anni (€ 16,00); Studente UE 18-25 anni (€ 16,00) | Low | 21/30 and 60/120 days open, first 2026-10-02, 2 slots per sampled day |
| Visita guidata del Chiostro e della Basilica di San Giovanni | 65 | +18 anni (€ 15,00); 6 - 17 anni (€ 10,00) | Low | 22/30 and 64/120 days open, first 2026-10-02, 1 slot per sampled day |
| Il servizio Open Bus Vatican&Rome | 4 | Intero +18 anni; 6 - 17 anni | No date booking | bought without choosing a date |
| Ingresso e Visita del Chiostro e della Basilica di San Giovanni | 63 | +18 anni; 6 - 17 anni | No date booking | bought without choosing a date |
| A Roma sui passi di San Camillo | – | – | Not sold online | card page has no purchase form |
| Bisanzio a Roma | – | – | Not sold online | card page has no purchase form |
| Cammino degli Angeli a Roma | – | – | Not sold online | card page has no purchase form |
| Donne Patrone d’Europa e Dottori della Chiesa | – | – | Not sold online | card page has no purchase form |
| Gli Apostoli a Roma | – | – | Not sold online | card page has no purchase form |
| Il cuore di Roma | – | – | Not sold online | card page has no purchase form |
| Ingresso ai Sotterranei della Basilica di Santa Maria in via Lata | – | – | Not sold online | card page has no purchase form |
| Le Corporazioni religiose a Roma | – | – | Not sold online | card page has no purchase form |
| Piazza Navona Underground e audioguida "Cuore di Roma" | – | – | Not sold online | card page has no purchase form |
| Roma Pass - musei e siti archeologici | – | – | Not sold online | card page has no purchase form |
| Roma: Santuario Mariano | – | – | Not sold online | card page has no purchase form |
| San Giovanni Battista a Roma | – | – | Not sold online | card page has no purchase form |
| Terra Santa a Roma | – | – | Not sold online | card page has no purchase form |
| Visita con audioguida della Basilica di San Marco e Sotterranei | – | – | Not sold online | card page has no purchase form |
| Visita guidata alla Basilica di San Marco e Sotterranei | – | – | Not sold online | card page has no purchase form |

## Refreshing this file

Run `node scarcity.js` in this folder (about 12 minutes, roughly 500 requests spaced 1.1 s apart). It discovers the cards from the site's index pages. `node scarcity.js <slug> [<slug> …]` probes only the given cards.



kol proxy l cookie mteeou, 