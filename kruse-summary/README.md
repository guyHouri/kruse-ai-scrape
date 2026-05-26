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
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
```

## Commands

```bash
# Build HTML from existing curated JSON or raw fallback.
npm run build

# Run summary, mailing-list, renderer, and website tests.
npm test

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

The signup and feedback forms post directly to Supabase from the static GitHub
Pages site. This does not need a backend service as long as the tables are
protected by RLS:

- `kruse_mailing_list`: first name, last name, email, comments, delivery, report
  date, report URL, page URL, and created timestamp.
- `kruse_report_feedback`: first name, last name, optional email, rating,
  comments, report date, report URL, page URL, and created timestamp.

The browser receives only `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Public users have `INSERT` permission
only. They cannot read, update, or delete either table.

For deployed builds, set these GitHub Actions variables:

```text
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_MAILING_LIST_TABLE=kruse_mailing_list
SUPABASE_FEEDBACK_TABLE=kruse_report_feedback
```

For email delivery, the scheduled workflow can sync Supabase signups back into
`mailing_list.json`. Set this GitHub Actions secret:

```text
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
```

The service-role key is server-only. Never put it in `NEXT_PUBLIC_*` variables
or static HTML.

### Reading Signups And Feedback

The public browser key can only insert rows. To view the private data, use the
Supabase dashboard or a server-side SQL connection.

Dashboard links:

```text
Mailing list:
https://supabase.com/dashboard/project/zpxhovwsswnjdjibcvsh/editor?schema=public&table=kruse_mailing_list

Report feedback:
https://supabase.com/dashboard/project/zpxhovwsswnjdjibcvsh/editor?schema=public&table=kruse_report_feedback
```

Useful SQL:

```sql
select created_at, first_name, last_name, email, frequency, comments, report_date, report_url
from public.kruse_mailing_list
order by created_at desc;

select created_at, report_date, rating, first_name, last_name, email, comments, report_url
from public.kruse_report_feedback
order by created_at desc;
```

`mailing_list.json` is the local/email-sender copy. It is updated from Supabase
by `npm run sync-mailing-list` only when `SUPABASE_SERVICE_ROLE_KEY` is set in
the environment or as a GitHub Actions secret.

The scheduled workflow runs:

```bash
npm run sync-mailing-list
```

That command first tries Supabase with `SUPABASE_SERVICE_ROLE_KEY`. If that is
not configured, it falls back to the older Google Sheet paths. It merges new
emails into `mailing_list.json`, and the workflow commits that file back to the
repo. From that point, the next email send uses the updated list automatically.

Run the sync locally:

```bash
cd kruse-summary
SUPABASE_URL=https://<project-ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<service-role-key> npm run sync-mailing-list
```

PowerShell:

```powershell
cd "D:\kruse\guy export\kruse-summary"
$env:SUPABASE_URL="https://<project-ref>.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="<service-role-key>"
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

### Running The Full Daily Pipeline

The GitHub workflow is `.github/workflows/daily-kruse-summary.yml`. It runs on
the current `REPORT_TIME_ZONE` day, scrapes X, scrapes the forum, builds the AI
report, sends email, deploys GitHub Pages, and commits the generated daily
state back to `main`.

Manual GitHub run:

```bash
gh workflow run "Daily Kruse Summary" --ref main -f mode=force -f date=2026-05-26
```

If `gh` says it is not authenticated but normal `git push` works, Git
Credential Manager may already have a GitHub token. PowerShell:

```powershell
$cred = "protocol=https`nhost=github.com`n`n" | git credential fill
$env:GH_TOKEN = (($cred | Where-Object { $_ -like 'password=*' } | Select-Object -First 1).Substring('password='.Length))
gh auth status
gh workflow run "Daily Kruse Summary" --ref main -f mode=force -f date=2026-05-26
```

If that still fails, use GitHub Actions in the browser: open the workflow, click
`Run workflow`, set `mode=force`, and enter the date.

Local equivalent:

```bash
cd twitter_to_md
npm.cmd install
node main.js --date=2026-05-26

cd ../forum_to_md
npm.cmd install
node main-daily.js

cd ../kruse-summary
npm.cmd install
npm.cmd run sync-mailing-list
node code/build-input.js 2026-05-26
node main.js --force --use-ai --date=2026-05-26
npm.cmd run deploy-site
```

The workflow commits `twitter_to_md/data`, `forum_to_md/daily`,
`kruse-summary/curated`, `kruse-summary/out`, `mailing_list.json`, and
`last-sent.json`. That keeps the daily source JSON, AI intermediate files,
final HTML, email state, and recipient list auditable in Git.

The workflow also runs `npm test` in `twitter_to_md` and `kruse-summary` before
calling paid/network stages. In `force` mode it re-fetches X and forum data even
when the day's JSON already exists.

`SUPABASE_SERVICE_ROLE_KEY` must be set as a GitHub Actions secret. Without it,
GitHub Actions cannot read private Supabase signups because the browser key is
insert-only by design.

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
