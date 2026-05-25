# kruse-summary

Daily report pipeline. It reads scraped tweets from `../twitter_to_md/data`,
optionally reads forum activity from `../forum_to_md/daily`, creates a curated
summary JSON, renders HTML, and can email the report before local sunrise.

## Flow

1. `main.js` chooses the report date, defaulting to current `REPORT_TIME_ZONE`.
2. With `--use-ai`, `code/build-input.js` creates
   `curated/<date>-input.json` from a 24-hour tweet/forum window.
3. `code/summarize.js` saves podcast URLs to
   `curated/<date>-podcasts.json`.
4. `prompts/select-system.md` classifies every tweet/forum item and selects
   useful source-bound signal packets.
5. Code gates out podcast-deferred and low-priority items.
6. `prompts/write-system.md` writes source-grouped `Twitter Updates` and
   `Forum Updates` cards to `curated/<date>-draft.json`.
7. `prompts/explain-system.md` detects scientific/medical/technical terms
   dynamically and adds concept explanations.
8. Code verifies selection coverage, source IDs, forum URLs, source quotes,
   citations, podcast leakage, and required scientific explanations.
9. `code/build-report.js` renders `out/<date>.html`.
10. In send mode, `code/sunrise.js`, `code/email.js`, and `code/state.js`
   handle sunrise window, Gmail, and idempotency.

## Important Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) - short current architecture:
  what, how, and why.
- [`docs/REQUEST_TRACE.md`](docs/REQUEST_TRACE.md) - detailed requirement map.

## Files

```text
kruse-summary/
  main.js
  settings.js
  code/
    build-input.js
    compact.js
    summarize.js
    build-report.js
    sunrise.js
    email.js
    state.js
    logger.js
  prompts/
    select-system.md
    write-system.md
    explain-system.md
    output-schema.json
  docs/
    ARCHITECTURE.md
    REQUEST_TRACE.md
  curated/
  out/
```

## Setup

```bash
npm install
cp .env.example .env
```

Required only for email:

```text
GMAIL_USER
GMAIL_APP_PASSWORD
```

Required only for AI summaries:

```text
ANTHROPIC_API_KEY
```

Useful optional env vars:

```text
SCRAPED_DATA_DIR=../twitter_to_md/data
FORUM_DAILY_DIR=../forum_to_md/daily
KRUSE_BLOG_SERIES_DIR=../private/kemono_to_md/processed_mds/blog_series
KRUSE_BLOG_ARTICLES_PATH=../private/kemono_to_md/articles.json
SUMMARY_WINDOW_HOURS=24
REPORT_TIME_ZONE=Asia/Jerusalem
KRUSE_AI_SELECTION_MIN_PRIORITY=3
ANTHROPIC_MODEL=claude-haiku-4-5
ANTHROPIC_MAX_TOKENS=20000
KRUSE_SITE_PUBLIC_BASE_URL=https://guyhouri.github.io/kruse-ai-scrape
KRUSE_SITE_FORM_ENDPOINT=https://formsubmit.co/guyhouri.tech@gmail.com
```

## Commands

```bash
# Build HTML from existing curated JSON or raw fallback.
npm run build

# Build daily AI input JSON only.
npm run build-input -- 2026-05-24

# Build HTML using Anthropic. This writes curated/<date>.json after validation.
npm run build-ai -- --date=2026-05-24

# Build the static public report archive website.
npm run build-site

# Build and publish the static site to GitHub Pages.
npm run deploy-site

# Normal scheduled behavior: build, check sunrise window, send only if allowed.
npm start

# Bypass sunrise and last-sent gates, then send.
npm run force-send
```

PowerShell may block `npm`; use `npm.cmd` in that case.

## Public Report Site

`npm run build-site` writes a static website to `site/`.

Free public hosting path:

- Build with `npm run build-site`.
- Publish `site/` to GitHub Pages from the `gh-pages` branch.
- Public URL: `https://guyhouri.github.io/kruse-ai-scrape/`.

The signup and feedback forms post to `KRUSE_SITE_FORM_ENDPOINT`. The default
uses FormSubmit. Signups are automatically synced into `mailing_list.json` when
`FORMSUBMIT_API_KEY` is configured; the daily GitHub Action runs that sync before
sending.

Current default:

```text
KRUSE_SITE_FORM_ENDPOINT=https://formsubmit.co/guyhouri.tech@gmail.com
```

FormSubmit emails a copy of every submission to `guyhouri.tech@gmail.com`.
Search Gmail for these subjects when debugging:

```text
Kruse report mailing-list request
Kruse report request - YYYY-MM-DD
Kruse report feedback - YYYY-MM-DD
```

The per-report forms also send hidden fields:

```text
form-name=kruse-report-interest | kruse-report-feedback
report_date=YYYY-MM-DD
report_url=https://guyhouri.github.io/kruse-ai-scrape/reports/YYYY-MM-DD.html
```

FormSubmit may send a one-time activation email the first time the public form
is submitted. Confirm it from Gmail; after that submissions should arrive as
regular emails and appear in the archive API.

To turn automatic signup sync on, request a FormSubmit API key to Gmail:

```bash
curl -X GET https://formsubmit.co/api/get-apikey/guyhouri.tech@gmail.com
```

Then use the emailed key:

```bash
curl -X GET https://formsubmit.co/api/get-submissions/<apikey>
```

Treat that API key like a password.

Then add it as a GitHub repo secret:

```text
Settings -> Secrets and variables -> Actions -> New repository secret
Name: FORMSUBMIT_API_KEY
Value: <the key FormSubmit emailed>
```

The scheduled workflow runs:

```bash
npm run sync-mailing-list
```

That command fetches FormSubmit submissions, keeps only
`kruse-report-interest`, merges new emails into `mailing_list.json`, and the
workflow commits that file back to the repo. From that point, the next email
send uses the updated list automatically.

Run the sync locally:

```bash
cd kruse-summary
FORMSUBMIT_API_KEY=<apikey> npm run sync-mailing-list
```

PowerShell:

```powershell
cd "D:\kruse\guy export\kruse-summary"
$env:FORMSUBMIT_API_KEY="<apikey>"
npm.cmd run sync-mailing-list
```

To publish manually:

```bash
cd kruse-summary
npm run build-site
npm run deploy-site
```

`npm run deploy-site` rebuilds `site/` and pushes that folder to the repository's
`gh-pages` branch. GitHub Pages serves that branch at:

```text
https://guyhouri.github.io/kruse-ai-scrape/
```

## Output Contract

`curated/<date>.json` is the renderer contract. The schema is
`prompts/output-schema.json`.

Every AI-generated card must have:

- source IDs or forum URLs from the same-day input;
- a `source_quote` found in the same-day source text;
- citations only from same-day `source_citations`;
- concept explanations for medical/scientific terms detected by the
  science-explainer pass.

Curated reports do not append raw forum posts. Forum signal must pass the same
selection and card-writing process as tweets.
