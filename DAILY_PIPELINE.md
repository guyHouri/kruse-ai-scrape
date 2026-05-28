# Daily Kruse Pipeline

End-to-end daily workflow for the public Kruse report site and mailing-list email send.
This is separate from the NotebookLM archive scrapers: the archive scrapers
produce long-term markdown bundles, while this pipeline produces one daily HTML
report from the last 24 hours of X and forum activity.

## Current Shape

The active automation is `.github/workflows/daily-kruse-summary.yml`.

- Runs with staggered scheduled attempts and a user-facing target of
  `04:00 Asia/Jerusalem`.
- Uses `REPORT_TIME_ZONE`, default `Asia/Jerusalem`, to choose the report date
  and the local send time.
- Accepts manual `workflow_dispatch`.
- Accepts external `repository_dispatch` with event type `daily-kruse-summary`.
- Sends email to the synced mailing list. A temporary test gate can still be
  enabled with `KRUSE_EMAIL_TEST_RECIPIENTS`, but it is not active by default.
- Commits generated daily data, report HTML, mailing-list sync, and website
  files back to `main`.
- Triggers `.github/workflows/ci-cd.yml` after the daily commit.

Manual `send-existing` mode reuses the already-committed curated report for a
date and sends it without scraping again or calling Anthropic again. Use it when
an approved test report should now go to the full mailing list.

## Date And Time Rules

The report date is not hardcoded. The workflow picks it like this:

1. If a manual or repository-dispatch payload includes `date`, use that exact
   `YYYY-MM-DD`.
2. Otherwise, run `TZ="$REPORT_TIME_ZONE" date +%Y-%m-%d`.
3. Pass that date to the X scraper, forum scraper, input builder, AI summary,
   HTML renderer, email sender, and public-site builder.

The desired product behavior is simple: the email should already be in the
mailbox at `04:00` Israel time. GitHub's cron syntax is UTC-only, so the YAML
uses staggered UTC triggers and the workflow has a `Wait until 04:00 Israel
time` step. In Israel summer time, the first two attempts usually wait until
04:00 and the third attempt starts after the target time. In Israel winter
time, the wait step handles the offset. There is no sunrise API in the send
path.

If the workflow does not appear at the scheduled minute, that is not a date
calculation bug by itself. GitHub scheduled workflows can start late or fail to
start. The staggered attempts reduce the risk, but the strongest fix is an
external watchdog, not changing the report-date logic.

## Pipeline Steps

The daily workflow is intentionally linear. If a required step fails, later
steps do not run.

1. Checkout `main`.
2. On scheduled runs, wait until `04:00` in `REPORT_TIME_ZONE`.
3. Install and test `twitter_to_md`.
4. Install and test `kruse-summary`.
5. Pick the target report date.
6. Scrape X as a rolling 24-hour window into
   `twitter_to_md/data/<date>.json`.
7. Scrape forum activity into `forum_to_md/daily/<date>.json`.
8. Sync Supabase mailing-list rows into `kruse-summary/mailing_list.json`.
9. Build combined daily input at `kruse-summary/curated/<date>-input.json`.
10. Run Anthropic prompt chain and validation.
11. Render `kruse-summary/out/<date>.html`.
12. Send the email if the run mode allows sending and the date was not already
    sent.
13. Write `kruse-summary/last-sent.json` only after email succeeds.
14. Build the static public site into `kruse-summary/site`.
15. Mirror the static site into `docs`.
16. Commit generated artifacts and push to `main`.
17. Dispatch the CI/CD workflow.
18. CI/CD runs tests again and deploys `docs` to GitHub Pages only after tests
    pass.

## AI Summary Chain

The report is not one giant prompt. It is a staged chain so each step has one
job:

1. `build-input` collects same-day X and forum items in one JSON file.
2. `select-system.md` removes low-signal items and keeps only new protocols,
   mechanisms, concrete cases, cited papers, datasets, new claims, and useful
   forum updates.
3. Code gates remove podcast-only items and enforce minimum priority.
4. `write-system.md` writes source-grounded Twitter and Forum cards without
   adding personal opinion.
5. `explain-system.md` repairs unclear medical, scientific, and technical
   language.
6. Code repairs common model formatting mistakes, including missing card
   `source_ids`/`source_urls`, from the already-approved selected items.
7. Code validators check source IDs, source quotes, same-day citations,
   citation bibliographic anchors, forum URLs, podcast leakage, duplicate
   cards, and missing explanations.
8. The renderer builds the final HTML from validated JSON.

Forum updates must go through the same select, write, explain, and verify
process as tweets. Forum items are not raw appendices and are not second-class
content.

## Testing Gates

There are two testing gates.

The daily workflow runs:

```text
twitter_to_md: npm test
kruse-summary: npm test
```

The CI/CD workflow repeats the same tests before deploying the public website.

Tests cover the X daily JSON behavior, summary validation repairs, site build
behavior, email recipient filtering, Supabase form behavior, and unsubscribe
logic. The practical rule is simple: if tests fail, the workflow must not send
or deploy.

## Failure Behavior

Failure should be boring and visible.

| Failure point | What happens | Why |
|---|---|---|
| Unit tests fail | Stop before scraping/sending/deploying | Broken code should not spend API money or email users |
| X scrape fails | Stop before summary and email | Missing source data makes the report unreliable |
| Forum scrape fails | Stop before summary and email | Forum and X use the same daily report contract |
| Supabase mailing-list sync fails | Stop before email | We do not guess the recipient list |
| Anthropic generation fails | Stop before email | No validated report means no send |
| Validator rejects output | Stop before email | Prevents hallucinated, uncited, or unclear cards |
| Anthropic omits a selected card source reference | Repair from the selected item, then validate | Keeps strict provenance without failing on recoverable JSON omissions |
| Gmail send fails | Do not update `last-sent.json` | A retry should still be allowed |
| Commit or deploy fails after send | Email may be sent, site may lag | Re-run CI/CD or daily workflow to repair the site |
| GitHub schedule does not start | Nothing runs | Supabase watchdog should dispatch a backup run |

`last-sent.json` is the duplicate-send guard. It is updated only after a
successful send, so a failed email attempt can be retried. Manual `force` mode
can bypass normal safety gates and must be used carefully.

## Supabase Watchdog Dispatch

Yes, Supabase can dispatch the GitHub daily workflow. The repo side is already
ready because `.github/workflows/daily-kruse-summary.yml` listens for:

```yaml
repository_dispatch:
  types: [daily-kruse-summary]
```

GitHub's repository-dispatch endpoint is the correct outside-GitHub trigger:

```http
POST https://api.github.com/repos/guyHouri/kruse-ai-scrape/dispatches
```

Payload:

```json
{
  "event_type": "daily-kruse-summary",
  "client_payload": {
    "mode": "normal",
    "date": ""
  }
}
```

Supabase has two good ways to do the watchdog:

1. Supabase Cron plus `pg_net` calls GitHub directly.
2. Supabase Cron calls an Edge Function, and the Edge Function calls GitHub.

Use the Edge Function path if we want more logic, logging, and cleaner secret
handling. Use direct `pg_net` only for the smallest possible implementation.

Required server-only secret:

```text
GITHUB_DISPATCH_TOKEN
```

That token needs permission to create a repository dispatch for
`guyHouri/kruse-ai-scrape`. It must live in Supabase Vault or Edge Function
secrets. It must never be placed in static HTML, `NEXT_PUBLIC_*`, or a browser
form.

Recommended watchdog timing:

```text
04:45 Asia/Jerusalem daily
```

That gives the normal 04:00 Israel run time to start and finish. The watchdog
should dispatch only when today's report has not been sent/deployed.
The safest long-term check is a Supabase table:

```sql
create table if not exists public.kruse_daily_runs (
  report_date date primary key,
  status text not null,
  github_run_id bigint,
  report_url text,
  sent_at timestamptz,
  deployed_at timestamptz,
  error text,
  updated_at timestamptz not null default now()
);
```

Then the daily workflow should upsert:

```text
started -> scraped -> summarized -> sent -> deployed
```

If the watchdog sees no row for today, or a stale row before `sent`, it sends
the repository dispatch. Duplicate protection still exists in GitHub
concurrency and `last-sent.json`, but the run-status table makes failures
obvious from Supabase.

Current repo status: the GitHub workflow can receive the Supabase dispatch now.
The Supabase-side scheduled job still needs to be installed with a server-side
GitHub dispatch token. This machine currently has no Supabase CLI, no `psql`,
no Supabase access token, and no database URL configured, so the watchdog cannot
be installed from here without adding one of those deployment paths.

## Medical And Science Explanation Policy

The explainer should not waste space teaching the reader the Kruse basics every
day. These are baseline concepts and should usually not get glossary treatment:

- blue light;
- nnEMF;
- deuterium;
- deuterium-depleted water;
- sunrise;
- cold exposure;
- DHA;
- grounding;
- magnetism;
- redox;
- leptin signaling;
- decentralized medicine;
- biophysics of patients.

The explainer should explain harder medical, anatomical, biochemical,
pharmacological, and physics terms when they are necessary to understand the
card. Examples:

- conditions: hypothyroidism, GERD, hiatal hernia, autoimmune thyroiditis;
- anatomy: lower esophageal sphincter, vagus nerve, thyroid gland;
- drugs and compounds: doxycycline, 5-FU, ivermectin, fenbendazole, mastic gum;
- lab or measurement terms: TSH, free T3, ferritin, inflammatory markers;
- mechanisms: mitochondrial complex IV, cytochrome c oxidase, dielectric
  constant, isotope effect, bicarbonate secretion, proton tunneling;
- unclear Kruse-style phrases: water table collapse, lattice lock, optical
  switch, charge separation.

If a baseline Kruse word appears inside a harder mechanism, explain the harder
mechanism rather than the baseline word. For example:

- Explain `kinetic isotope effect`, not just `deuterium`.
- Explain `dielectric collapse`, not just `blue light`.
- Explain `lower esophageal sphincter tone`, not just `GERD`.

The target reader is smart but not a doctor. A good explanation should say:

1. what the term means in normal language;
2. what system it belongs to;
3. why it matters for this specific card;
4. whether the source text actually supports the mechanism or only asserts it.

The verifier should reject cards where the main claim depends on an unexplained
medical/science term or an unclear private phrase. The repair step should add a
plain-language definition or rewrite the sentence. If the source itself does
not provide enough information to explain the phrase, the card should say that
plainly or be dropped.

## Citation Policy

The report citation box is only for real, checkable research references. Source
links already cover tweets and forum posts, so a vague phrase like "a narrative
review", "a study", "a paper", or "a review in Clinical Bioenergetics" is not
enough.

A formal citation must carry bibliographic anchors such as author/researcher
plus year, journal/source plus year, author/researcher plus journal/source,
paper title plus year, DOI, PMID, PMCID, arXiv ID, or clinical-trial ID. If a
source only mentions a review without those anchors, the pipeline may summarize
the source-bound claim but keeps `citations: []` and does not render it as a
research citation.

## Manual Operations

Run the daily workflow from GitHub CLI:

```powershell
gh workflow run "Daily Kruse Summary" --repo guyHouri/kruse-ai-scrape --ref main -f mode=force -f date=2026-05-27
gh workflow run "Daily Kruse Summary" --repo guyHouri/kruse-ai-scrape --ref main -f mode=send-existing -f date=2026-05-27
```

Repository-dispatch fallback:

```powershell
'{"event_type":"daily-kruse-summary","client_payload":{"mode":"force","date":"2026-05-27"}}' |
  gh api repos/guyHouri/kruse-ai-scrape/dispatches --method POST --input -
```

Local equivalent:

```powershell
cd "D:\kruse\guy export\twitter_to_md"
npm.cmd install
node main.js --date=2026-05-27

cd "..\forum_to_md"
npm.cmd install
node main-daily.js --date=2026-05-27 --force

cd "..\kruse-summary"
npm.cmd install
npm.cmd test
npm.cmd run sync-mailing-list
node code/build-input.js 2026-05-27
node main.js --force --use-ai --date=2026-05-27
npm.cmd run build-site
```

Check generated files:

```text
twitter_to_md/data/<date>.json
forum_to_md/daily/<date>.json
kruse-summary/curated/<date>-input.json
kruse-summary/curated/<date>.json
kruse-summary/out/<date>.html
docs/reports/<date>.html
```

Public site:

```text
https://guyhouri.github.io/kruse-ai-scrape/
```
