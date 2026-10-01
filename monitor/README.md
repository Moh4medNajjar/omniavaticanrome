# Ticket-drop monitor

Watches the Carcer Tullianum + Colosseo card on omniavaticanrome.org and alerts when new dates become bookable.
By default it is read-only: it never adds to cart or holds tickets. You book manually after the alert.

Proof-of-concept mode: with `HOLD_SECONDS` set, a drop triggers one hold and release.
- **What is held:** one order in each area that dropped (Carcere, Colosseo or both), on the first newly available date. The order is the card's per-order maximum, read from the card page (7 today), or `HOLD_QTY` if lower. It is a single session and a single order; it never goes to checkout or payment.
- **Release:** after `HOLD_SECONDS` every hold is released through `delete_reservations`, with up to 3 attempts each. A release counts only when the server's reply no longer lists the reservation codes.
- **If a release is not confirmed:** the monitor keeps the same session, retries every 30 seconds instead of checking for drops, and gives up with an alert after 6 rounds. Ctrl+C also releases. Killing the process (Task Manager, the scheduled task being stopped) does not.
- **Party size:** in this mode the session is opened for the whole order, so the monitor watches dates and slots that fit that many people. Changing the party size starts a new baseline.

Each hold, its reservation codes and each release attempt are written to `monitor.log` and added to the alert.

## How it works
Every `INTERVAL_MIN` minutes (plus up to 1 min of random jitter) it:
1. opens a session with the card page, `set_pax` and `multitickets`;
2. reads the calendar's blocked-date list (`exclude_days`) for Carcere Mamertino (CM) and Colosseo (CL) through `vouchers/reserve`;
3. compares the open dates with the previous check (`state.json`);
4. confirms any newly opened date has time slots through `get_availability`, then alerts you.

The first run only records a baseline. On errors it backs off, up to 8× the interval, and alerts after 5 consecutive failures.

## Config (environment variables)
| Var | Default | Meaning |
|---|---|---|
| `INTERVAL_MIN` | `10` | minutes between checks |
| `HORIZON_DAYS` | `400` | how far ahead to look |
| `WATCH_DATES` | – | e.g. `2026-12-26,2026-12-27`: also alert when these specific (sold-out) dates get slots |
| `HOLD_SECONDS` | `0` (off) | proof of concept: on a drop, hold one order this long, then release it (max 60) |
| `HOLD_QTY` | card maximum | tickets per area in the proof-of-concept hold; capped at the card's per-order limit |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | – | phone alerts through Telegram |
| `WEBHOOK_URL` | – | Discord or other webhook |

Windows desktop notifications are always on.

## Run
```
node monitor.js --once   # single test check
node monitor.js          # run forever
```
Logs are in `monitor.log`.

## Run 24/7 on this PC
`install-task.ps1` registers a Windows scheduled task that starts at logon and restarts if it crashes.
The PC must stay on and not sleep.
For a true 24/7 setup, run it on a small always-on server or a Raspberry Pi with `pm2 start monitor.js`.
