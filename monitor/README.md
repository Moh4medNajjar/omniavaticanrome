# Ticket-drop monitor

Watches the Carcer Tullianum + Colosseo card on omniavaticanrome.org and alerts when new dates become bookable.
It is read-only: it never adds to cart or holds tickets. You book manually after the alert.

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
