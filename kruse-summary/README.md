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
GOOGLE_FORM_RESPONSES_CSV_URL=https://docs.google.com/spreadsheets/d/e/.../pub?output=csv
KRUSE_GOOGLE_FORM_ACTION=https://docs.google.com/forms/d/e/<form-id>/formResponse
KRUSE_GOOGLE_FORM_ENTRY_EMAIL=entry.333333333
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

The signup and feedback forms can post directly to Google Forms. A linked Google
Sheet then becomes the source for automatic mailing-list sync.

Create one Google Form with these fields:

```text
Form name
Name
Email
Delivery
Report date
Report URL
Rating
Feedback
```

Recommended choices:

```text
Form name: short answer
Name: short answer
Email: short answer
Delivery: multiple choice with Daily, Only strong signal days, Weekly digest
Report date: short answer
Report URL: short answer
Rating: multiple choice with Useful, Mixed, Bad
Feedback: paragraph
```

Use the Google Forms `formResponse` URL plus the field entry IDs as GitHub
Actions variables:

```text
KRUSE_GOOGLE_FORM_ACTION=https://docs.google.com/forms/d/e/<form-id>/formResponse
KRUSE_GOOGLE_FORM_ENTRY_TYPE=entry.111111111
KRUSE_GOOGLE_FORM_ENTRY_NAME=entry.222222222
KRUSE_GOOGLE_FORM_ENTRY_EMAIL=entry.333333333
KRUSE_GOOGLE_FORM_ENTRY_FREQUENCY=entry.444444444
KRUSE_GOOGLE_FORM_ENTRY_REPORT_DATE=entry.555555555
KRUSE_GOOGLE_FORM_ENTRY_REPORT_URL=entry.666666666
KRUSE_GOOGLE_FORM_ENTRY_RATING=entry.777777777
KRUSE_GOOGLE_FORM_ENTRY_FEEDBACK=entry.888888888
```

Simpler first version: set only this variable and the website will link people
to the hosted Google Form instead of using the custom in-page form:

```text
KRUSE_GOOGLE_FORM_PUBLIC_URL=https://docs.google.com/forms/d/e/<form-id>/viewform
```

Then link the form to a Google Sheet and publish the responses sheet as CSV.
Save that CSV URL as a GitHub Actions secret:

```text
Name: GOOGLE_FORM_RESPONSES_CSV_URL
Value: https://docs.google.com/spreadsheets/d/e/.../pub?output=csv
```

The public forms send these values:

```text
Form name=kruse-report-interest | kruse-report-feedback
Report date=YYYY-MM-DD
Report URL=https://guyhouri.github.io/kruse-ai-scrape/reports/YYYY-MM-DD.html
```

The scheduled workflow runs:

```bash
npm run sync-mailing-list
```

That command fetches the Google Sheet CSV, keeps only `kruse-report-interest`,
merges new emails into `mailing_list.json`, and the workflow commits that file
back to the repo. From that point, the next email send uses the updated list
automatically.

Run the sync locally:

```bash
cd kruse-summary
GOOGLE_FORM_RESPONSES_CSV_URL=<csv-url> npm run sync-mailing-list
```

PowerShell:

```powershell
cd "D:\kruse\guy export\kruse-summary"
$env:GOOGLE_FORM_RESPONSES_CSV_URL="<csv-url>"
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
