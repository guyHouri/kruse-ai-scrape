# kruse-summary

Daily report pipeline. It reads scraped tweets from `../twitter_to_md/data`,
optionally reads forum activity from `../forum_to_md/daily`, creates a curated
summary JSON, renders HTML, and can email the report.

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
8. Code repairs recoverable model omissions, including missing card
   `source_ids`/`source_urls`, from the selected source item.
9. Blog IDs such as `CPC#84` and `DM#63` are handled as Kruse archive
   references, not formal citations.
10. Code verifies selection coverage, source IDs, forum URLs, source quotes,
   citations, citation bibliographic anchors, podcast leakage, and required
   scientific explanations.
11. `code/build-report.js` renders `out/<date>.html`.
12. In send mode, `code/email.js` and `code/state.js` handle Gmail and
   idempotency. The GitHub workflow controls the 04:00 Israel send time.

## Important Docs

- [`../DAILY_PIPELINE.md`](../DAILY_PIPELINE.md) - current daily workflow,
  testing gates, failure behavior, Supabase watchdog plan, and medical-term
  explanation policy.

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
    email.js
    state.js
    logger.js
  prompts/
    select-system.md
    write-system.md
    explain-system.md
    output-schema.json
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

# Legacy fallback: build and publish through the old gh-pages path.
npm run deploy-site

# Normal behavior: build and send if this report date was not already sent.
npm start

# Build/send now while still respecting last-sent.
node main.js --use-ai --date=2026-05-27

# Bypass last-sent gate, then send.
npm run force-send
```

PowerShell may block `npm`; use `npm.cmd` in that case.

## Public Report Site

`npm run build-site` writes a static website to `site/`.

Free public hosting path:

- Build with `npm run build-site`.
- Mirror `site/` into the repository `docs/` folder.
- Push/commit `docs/` to `main`.
- `.github/workflows/ci-cd.yml` runs tests and deploys `docs/` to GitHub Pages.
- Public URL: `https://guyhouri.github.io/kruse-ai-scrape/`.

The signup and feedback forms post directly to Supabase from the static GitHub
Pages site. This does not need a backend service as long as the tables are
protected by RLS:

- `kruse_mailing_list`: first name, last name, email, comments, delivery/frequency,
  report date, report URL, page URL, source, and created timestamp. Signups use
  `source='report-site'`; unsubscribe requests use `source='unsubscribe'`.
- `kruse_report_feedback`: first name, last name, optional email, rating,
  comments, report date, report URL, page URL, and created timestamp.

The browser receives only `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Public users have `INSERT` permission
only. They cannot read, update, or delete either table.

The static site also publishes `/unsubscribe/`. That page inserts an
unsubscribe row into `kruse_mailing_list`; it does not delete rows from
Supabase in the browser. During `npm run sync-mailing-list`, the latest row per
email wins. If the latest row is an unsubscribe row, that email is removed from
`mailing_list.json` before the next send.

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

select distinct on (email) email, source, frequency, created_at
from public.kruse_mailing_list
order by email, created_at desc;

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
emails into `mailing_list.json`, removes emails whose latest Supabase row is an
unsubscribe request, and the workflow commits that file back to the repo. From
that point, the next email send uses the updated list automatically.

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

The public GitHub Pages site is served from `main:/docs`. The daily workflow
builds `kruse-summary/site`, mirrors it into `docs/`, commits the generated
site with the daily artifacts, and then triggers `.github/workflows/ci-cd.yml`.
That CI/CD workflow runs tests first and deploys `docs/` only after tests pass.

Public URL:

```text
https://guyhouri.github.io/kruse-ai-scrape/
```

Local publish path:

```bash
cd kruse-summary
npm run build-site
```

Then mirror `kruse-summary/site` into the repository `docs/` folder and commit
the result. `npm run deploy-site` still exists as a legacy `gh-pages` fallback,
but `main:/docs` plus `.github/workflows/ci-cd.yml` is the active Pages path.

### Running The Full Daily Pipeline

The scheduled data workflow is `.github/workflows/daily-kruse-summary.yml`. It
targets `04:00` in the current `REPORT_TIME_ZONE`, default `Asia/Jerusalem`;
scrapes X as a rolling 24-hour window; scrapes the forum; syncs Supabase
signups; builds the AI report; sends email; mirrors the generated site into
`docs`; commits the generated
daily state back to `main`; and triggers the CI/CD deploy. `last-sent.json`
prevents duplicate email on manual retries or re-runs.

The main-branch CI/CD workflow is `.github/workflows/ci-cd.yml`. It runs on
pushes to `main`, manual dispatch, and the daily workflow's
`deploy-report-site` repository dispatch. It runs `twitter_to_md` and
`kruse-summary` tests first, then deploys the public website from `docs/`.

The daily workflow can also be triggered by an external Supabase watchdog using
GitHub `repository_dispatch` with event type `daily-kruse-summary`. The repo
side is already wired; Supabase still needs a server-side GitHub dispatch token
and a scheduled Cron or Edge Function. See [`../DAILY_PIPELINE.md`](../DAILY_PIPELINE.md).

### Failure And Explanation Policy

The daily workflow stops before paid AI calls, email, or deploy when tests fail.
It also stops when source scraping, Supabase sync, Anthropic generation, or
validation fails. `last-sent.json` is updated only after a successful email, so
failed sends remain retryable.

The explainer pass should not re-teach known Kruse basics such as blue light,
nnEMF, deuterium, sunrise, cold, DHA, grounding, magnetism, redox, leptin,
decentralized medicine, or biophysics of patients. It should explain harder
medical, anatomical, drug, lab, and mechanism terms such as hypothyroidism,
GERD, hernia, lower esophageal sphincter, doxycycline, 5-FU, mitochondrial
complex IV, dielectric collapse, isotope effect, and unclear Kruse phrases like
water table collapse or lattice lock.

### Email Audience

The daily GitHub workflow sends to the synced mailing list by default. For a
temporary test-only run, set `KRUSE_EMAIL_TEST_RECIPIENTS` in the workflow env
or shell; `code/email.js` will filter delivery to those addresses.

Use `mode=send-existing` when an already-approved report should be sent without
scraping again or calling Anthropic again.

Manual GitHub run:

```bash
gh workflow run "Daily Kruse Summary" --ref main -f mode=force -f date=2026-05-26
gh workflow run "Daily Kruse Summary" --ref main -f mode=send-existing -f date=2026-05-26
```

If `gh` says it is not authenticated but normal `git push` works, Git
Credential Manager may already have a GitHub token. PowerShell:

```powershell
$cred = "protocol=https`nhost=github.com`n`n" | git credential fill
$env:GH_TOKEN = (($cred | Where-Object { $_ -like 'password=*' } | Select-Object -First 1).Substring('password='.Length))
gh auth status
gh workflow run "Daily Kruse Summary" --ref main -f mode=force -f date=2026-05-26
```

If GitHub's workflow-dispatch endpoint returns a server error, use the
repository-dispatch fallback:

```powershell
gh api repos/guyHouri/kruse-ai-scrape/dispatches `
  -f event_type=daily-kruse-summary `
  -F client_payload[mode]=force `
  -F client_payload[date]=2026-05-26
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
npm.cmd run build-site
```

The daily workflow commits `twitter_to_md/data`, `forum_to_md/daily`,
`kruse-summary/curated`, `kruse-summary/out`, `mailing_list.json`, and
`last-sent.json`, plus the mirrored public site under `docs/`. That keeps the
daily source JSON, AI intermediate files, final HTML, email state, recipient
list, and deployed website source auditable in Git.

The daily workflow also runs `npm test` in `twitter_to_md` and `kruse-summary`
before calling paid/network stages. The CI/CD workflow runs the same tests
again before deploying from `main`. In `force` mode the daily workflow
re-fetches X and forum data even when the day's JSON already exists.

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
- formal citations with real bibliographic anchors: author/researcher, journal
  or source, year, DOI/PMID/PMCID/arXiv/clinical-trial ID, or equivalent
  combinations. Vague labels like "a narrative review in Clinical Bioenergetics"
  are treated as source context, not report citations;
- concept explanations for medical/scientific terms detected by the
  science-explainer pass.

Curated reports do not append raw forum posts. Forum signal must pass the same
selection and card-writing process as tweets.
