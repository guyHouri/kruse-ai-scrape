# Daily Kruse Pipeline

End-to-end automated daily digest of Dr. Jack Kruse content. Runs on
GitHub Actions every morning ~1 hour before sunrise in Jerusalem, emails
a curated HTML report to a mailing list.

> Separate from the NotebookLM bundle scrapers documented in
> [`README.md`](README.md). Those produce static archives; this is a
> recurring newsletter pipeline.

## Stack at a glance

```
                                  ┌──────────────────┐
                                  │  GitHub Actions  │
                                  │  cron 02-04 UTC  │
                                  └────────┬─────────┘
                                           │
        ┌──────────────────────────────────┼──────────────────────────────┐
        │                                  │                              │
        ▼                                  ▼                              ▼
┌───────────────────┐            ┌───────────────────┐          ┌─────────────────────┐
│  twitter_to_md/   │            │   forum_to_md/    │          │   kruse-summary/    │
│                   │            │   (daily mode)    │          │                     │
│ X API v2 →        │            │ XenForo login →   │          │ sunrise check →     │
│ per-day JSON      │            │ /find-new/posts → │          │ load tweets+forum → │
│                   │            │ per-day JSON      │          │ (TODO: AI summary) →│
└────────┬──────────┘            └────────┬──────────┘          │ render HTML →       │
         │                                │                     │ Gmail SMTP send →   │
         ▼                                ▼                     │ mark last-sent      │
data/2026-05-22.json           daily/2026-05-22.json            └──────────┬──────────┘
         │                                │                                │
         └────────────────────────────────┴────────────────────────────────┘
                                          │
                                committed back to repo
```

## Modules

### [`twitter_to_md/`](twitter_to_md/) — X scraper

- Official X API v2, App-only Bearer auth
- One JSON per UTC day at [`twitter_to_md/data/YYYY-MM-DD.json`](twitter_to_md/data/)
- Reply chain resolved recursively (`thread_context`), quoted/retweeted nested
- Pricing: `$0.005/tweet` × ~30-50/day × 30 = ~$5/mo (fits the $5 free credit)
- 24h server-side dedup means re-runs same day are free
- See [`twitter_to_md/README.md`](twitter_to_md/README.md)

### [`forum_to_md/`](forum_to_md/) — forum scraper (daily mode)

Two pipelines coexist in this folder:
1. **Legacy bulk pipeline** (`npm start`) — full archive scrape via static cookies (see [`forum_to_md/README.md`](forum_to_md/README.md)). Used to build NotebookLM bundles.
2. **Daily pipeline** (`npm run daily`) — username/password login + `/find-new/posts` fetch, saves last 24h to [`forum_to_md/daily/YYYY-MM-DD.json`](forum_to_md/daily/).

Daily mode auto-skips re-runs within 4 hours of the previous fetch
(idempotency on the morning cron's multiple fires). Force via `--force`.

### [`kruse-summary/`](kruse-summary/) — report + mailer

- Loads tweets + forum daily JSON
- Token-compact JSON for downstream AI ([`kruse-summary/code/compact.js`](kruse-summary/code/compact.js)) — ~70% smaller than full
- AI summarizer prompt + schema in [`kruse-summary/prompts/`](kruse-summary/prompts/) (Anthropic API call still TODO — currently raw-card fallback)
- HTML renderer matches the v2 design ([`kruse-summary/kruse-summary-v2-20-05-2026 .html`](kruse-summary/kruse-summary-v2-20-05-2026%20.html))
- Sunrise gate via [api.sunrise-sunset.org](https://sunrise-sunset.org/api), free
- Idempotency: [`kruse-summary/last-sent.json`](kruse-summary/last-sent.json) tracks `last_sent_for_date`
- Gmail SMTP via nodemailer; recipients in [`kruse-summary/mailing_list.json`](kruse-summary/mailing_list.json), BCC'd
- HTML attached as file so click-to-expand JS works when opened in browser

### [`.github/workflows/daily-kruse-summary.yml`](.github/workflows/daily-kruse-summary.yml)

GitHub Actions cron fires every 30 min from 02:00 to 04:30 UTC, covering
Jerusalem's pre-sunrise window year-round. Each fire:

1. Determine target date (yesterday UTC for tweets).
2. Skip tweet scrape if `twitter_to_md/data/<date>.json` already has `tweet_count > 0`.
3. Scrape tweets via X API.
4. Scrape forum new-posts (self-skips if <4h old).
5. Build HTML (sunrise check inside `main.js`; exits early if not in window).
6. Send mail if in window + not already sent for the date.
7. Commit scraped data + state files back to repo.

## Double-fetch protection (cost guard)

X API charges per tweet returned. Two layers prevent paying twice:

| Layer | What it does |
|---|---|
| Workflow file-existence check | Skips the entire scrape step if `data/<date>.json` has `tweet_count > 0` |
| X API 24h server-side dedup | Documented: re-requesting the same tweet ID within 24h is a single charge |
| `kruse-summary/settings.maxProjectedCostUsd` | Aborts a run before any API call if projected cost exceeds the cap (default $1.50) |
| `kruse-summary/last-sent.json` | Prevents mailing twice for the same day across multiple cron fires |

## Required GitHub repo secrets

Add at: **Repo → Settings → Secrets and variables → Actions → New repository secret**

| Name | Value source |
|---|---|
| `XAPI_BEARER_TOKEN` | X Developer Portal → your app → Keys and tokens → Bearer Token |
| `GMAIL_USER` | The Gmail account that sends the digest (e.g. `guyhouri.tech@gmail.com`) |
| `GMAIL_APP_PASSWORD` | Google App Password (16 chars, no spaces). Requires 2FA on the account. https://myaccount.google.com/apppasswords |
| `FORUM_USERNAME` | Your forum.jackkruse.com login email |
| `FORUM_PASSWORD` | Your forum.jackkruse.com password |
| `ANTHROPIC_API_KEY` *(future)* | Once the AI summarizer is wired |

Secret names can contain `[a-zA-Z0-9_]`. Underscores ARE allowed; spaces
are not. Use repository secrets, not environment secrets.

## Optional GitHub repo variables (not secrets)

| Name | Default | Purpose |
|---|---|---|
| `LOCATION_LAT` | `31.7683` | Sunrise API lat (Jerusalem) |
| `LOCATION_LON` | `35.2137` | Sunrise API lon (Jerusalem) |

## Local development

```bash
# X scraper
cd twitter_to_md && npm install
cp .env.example .env       # paste XAPI_BEARER_TOKEN
npm start                   # scrapes today UTC

# Forum daily scraper
cd ../forum_to_md && npm install
cp .env.example .env       # paste FORUM_USERNAME + FORUM_PASSWORD
npm run daily               # scrapes last 24h of forum

# Build + send report
cd ../kruse-summary && npm install
cp .env.example .env       # paste GMAIL_USER + GMAIL_APP_PASSWORD
node main.js --build-only --date=2026-05-22       # build HTML, no send
node main.js --force --date=2026-05-22            # force-send now, bypass sunrise gate
node main.js --send-v2-test                       # pipeline smoke test, sends static v2 HTML
```

## Forum section is currently OFF in the daily mail

The forum data is being scraped + committed daily, but the rendered HTML
omits the Forum Insights section until the user reviews quality and
approves wiring. Toggle by setting workflow env `INCLUDE_FORUM=true`.

## Status

- ✅ X scraper, per-day JSON
- ✅ Compact JSON for AI input (~70% smaller, readable keys)
- ✅ v2-styled HTML template (curated path + raw-card fallback)
- ✅ Email sender w/ HTML attachment
- ✅ Sunrise gate + last-sent idempotency
- ✅ GitHub Actions workflow
- ✅ Forum daily login + new-posts scrape
- ⏳ AI summarizer wiring (Anthropic API; ~$0.01/day Haiku 4.5)
- ⏳ Forum section in mail (gated, awaiting user approval)
- ⏳ Podcast pipeline (out of scope for now)

## Cost model (per month)

| Item | Cost |
|---|---|
| X API reads | ~$5/mo (within free credit) |
| Apify | $0 (not used) |
| Gmail SMTP | $0 |
| Sunrise API | $0 |
| GitHub Actions runtime | $0 (public repo, unlimited mins) |
| Anthropic Haiku 4.5 (planned) | ~$0.15-0.30/mo |
| **Total** | **~$5/mo, mostly inside free credits** |
