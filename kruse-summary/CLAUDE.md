# kruse-summary — AI assistant notes

Public docs: [`README.md`](README.md).

Daily newsletter pipeline. Runs on GitHub Actions, no local cron. Reads
scraped tweets from sibling `twitter_to_md/data/`, builds HTML, mails via
Gmail SMTP to recipients in `mailing_list.json`.

## Hosting

GitHub Actions cron `0,30 2-4 * * *` UTC. Inside-Node sunrise + last-sent
gates filter the fires down to one actual send per day.

Sunrise API: `https://api.sunrise-sunset.org/json?lat=&lng=&date=&formatted=0`.
No key. Returns ISO UTC.

## Code layout

| File | Purpose |
|---|---|
| `main.js` | Orchestrator: scrape → build → window check → send → mark |
| `settings.js` | env knobs (Gmail creds, lat/lon, pre-sunrise min, tolerance) |
| `code/build-report.js` | Tweet JSON → standalone HTML, v2-styled |
| `code/sunrise.js` | API call + window check |
| `code/email.js` | nodemailer Gmail SMTP, BCC the list |
| `code/state.js` | `last-sent.json` read/write |

## Idempotency

`last-sent.json` is committed back to the repo by the workflow on every
successful send. Subsequent same-day fires read it, see the date match,
exit early.

## Mail format

V2 HTML style copied inline (no external CSS — email clients need it embedded).
Currently one card per tweet in a single "Field Updates" section. AI-driven
themed cards is a TODO in `code/build-report.js`.

## Don't read into chat unless asked

- `out/*.html` — built reports, can be large
- `mailing_list.json` if it ever grows — load via `code/email.js`
