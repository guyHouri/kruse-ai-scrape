# kruse-summary

Daily email newsletter pipeline. Reads scraped tweets from
[`twitter_to_md`](../twitter_to_md/), renders a v2-styled HTML report, and
mails it to a list ~1 hour before local sunrise.

Hosted on **GitHub Actions** — no local cron, no server.

## How it works

1. GH Actions cron fires every 30 min from 02:00–04:30 UTC.
2. Each run:
   - Scrapes yesterday's tweets via `twitter_to_md/main.js --date=YYYY-MM-DD`.
   - Hits [api.sunrise-sunset.org](https://sunrise-sunset.org/api) for today's
     sunrise at the configured location (default Jerusalem).
   - If "now" is within ±30 min of `sunrise - 1 hour` **and** we haven't
     already sent for yesterday's report → builds HTML + sends via Gmail SMTP.
   - Marks `last-sent.json` to prevent duplicate sends; commits it back to
     the repo.
3. Otherwise exits silently and waits for the next cron fire.

## Files

```
kruse-summary/
  main.js                 # orchestrator
  settings.js             # env-driven knobs
  mailing_list.json       # recipient list (committed)
  last-sent.json          # state file, written by workflow
  code/
    build-report.js       # tweet JSON → HTML
    sunrise.js            # sunrise API + window check
    email.js              # nodemailer Gmail SMTP
    state.js              # last-sent persistence
    logger.js
  out/                    # built HTML lands here locally (gitignored)
```

## Setup (one-time)

### 1. Gmail App Password

- Account: `guyhouri.tech@gmail.com` (or override via `GMAIL_USER`).
- Enable 2-step verification on that account.
- Generate App Password: https://myaccount.google.com/apppasswords
- Save it; you'll paste it as a GH Actions secret next.

### 2. GitHub repo secrets

In repo → Settings → Secrets and variables → Actions, add:

| Secret | Value |
|---|---|
| `XAPI_BEARER_TOKEN` | X API Bearer Token (already needed by `twitter_to_md`) |
| `GMAIL_USER` | `guyhouri.tech@gmail.com` |
| `GMAIL_APP_PASSWORD` | the App Password from step 1 |

Optional **Variables** (not secrets) — override default Jerusalem location:

| Variable | Default |
|---|---|
| `LOCATION_LAT` | `31.7683` |
| `LOCATION_LON` | `35.2137` |

### 3. Mailing list

Edit `mailing_list.json`:

```json
{
  "recipients": [
    { "email": "guy.houri2024@gmail.com", "name": "Guy Houri" }
  ]
}
```

Commit. Recipients are BCC'd so addresses don't leak across the list.

## Local testing

```bash
cd kruse-summary
npm install
cp .env.example .env   # fill in GMAIL_USER, GMAIL_APP_PASSWORD

# Build HTML only (no send):
npm run build
# Output → out/<yesterday>.html

# Force-send now (bypasses sunrise window + last-sent gate):
npm run force-send
```

## Manual trigger from GitHub

Repo → Actions → "Daily Kruse Summary" → "Run workflow" → set `force=true` to
bypass the sunrise gate.

## TODO

- AI-summarized cards w/ themed tags + expandable concepts (currently raw 1
  card per tweet). Hook a Claude/OpenAI call in `code/build-report.js` →
  return structured `cards[]`, render those instead of raw tweets.
- Forum / podcast sections (require ingest from `forum_to_md` and a separate
  podcast pipeline).
