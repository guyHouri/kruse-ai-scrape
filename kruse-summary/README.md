# kruse-summary

Daily email newsletter pipeline. It reads scraped daily tweets from
`../twitter_to_md/data`, optionally reads forum daily activity from
`../forum_to_md/daily`, renders a v2-styled HTML report, and can mail it to
the list about one hour before local sunrise.

Hosted on GitHub Actions: no local cron, no server.

## Flow

1. GitHub Actions cron fires every 30 minutes from 02:00-04:30 UTC.
2. `main.js` chooses the report date, defaulting to the current UTC day.
3. If `--use-ai` is set, the module builds `curated/<date>-input.json` from a
   rolling 24-hour tweet/forum window, runs the default chained Anthropic
   editorial pipeline, validates the returned summary shape, and writes
   `curated/<date>.json`.
4. Otherwise it loads `curated/<date>.json` when present, or falls back to raw
   tweet cards.
5. `code/build-report.js` writes `out/<date>.html`.
6. Unless this is build-only or force mode, `code/sunrise.js` checks the send
   window. If the sunrise API is unavailable, the run skips sending and lets the
   next cron attempt try again.
7. `code/email.js` sends via Gmail SMTP and `code/state.js` marks
   `last-sent.json`.

Forum updates render by default when the curated summary has `forum.bullets`.
Set `INCLUDE_FORUM=false` only when you want to hide them.

## Files

```text
kruse-summary/
  main.js                 # orchestrator
  settings.js             # env-driven knobs
  mailing_list.json       # BCC recipients
  last-sent.json          # idempotency state
  code/
    build-input.js        # tweet/forum JSON -> curated/<date>-input.json
    compact.js            # compact tweet JSON for LLM input
    summarize.js          # Anthropic prompt chain + defensive JSON parsing
    build-report.js       # summary/raw JSON -> standalone HTML
    sunrise.js            # sunrise API + send-window check
    email.js              # nodemailer Gmail SMTP
    state.js              # last-sent persistence
    logger.js
  prompts/
    select-system.md      # pass 1: keep/drop source items
    evidence-system.md    # pass 2: extract usable evidence notes
    write-system.md       # pass 3: write renderer JSON draft
    editor-system.md      # pass 4: final editorial referee
    summarize-system.md   # legacy one-shot Claude instructions
    output-schema.json    # renderer-facing summary contract
    examples/
      golden-deconstruction.md
  curated/                # hand/AI summaries and AI input JSON
  out/                    # generated HTML and failed AI raw dumps
```

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and fill credentials as needed:

   ```bash
   cp .env.example .env
   ```

3. Required only for sending:

   ```text
   GMAIL_USER
   GMAIL_APP_PASSWORD
   ```

4. Required only for `--use-ai`:

   ```text
   ANTHROPIC_API_KEY
   ```

Optional knobs include `SCRAPED_DATA_DIR`, `FORUM_DAILY_DIR`,
`INCLUDE_FORUM=true`, `LOCATION_LAT`, `LOCATION_LON`,
`PRE_SUNRISE_MINUTES`, `TOLERANCE_MINUTES`, `ANTHROPIC_MODEL`,
`ANTHROPIC_MAX_TOKENS`, `SUMMARY_WINDOW_HOURS`, `KRUSE_AI_PIPELINE`, and
`KRUSE_AI_SELECTION_MIN_PRIORITY`.

`KRUSE_AI_PIPELINE=chain` is the default. It runs selection -> evidence ->
writer -> editor and writes inspectable intermediate files:

```text
curated/<date>-selection-audit.json
curated/<date>-selection-gated.json
curated/<date>-evidence-notes.json
curated/<date>-draft.json
curated/<date>.json
```

Set `KRUSE_AI_PIPELINE=single` only when you want to compare against the older
one-shot prompt in `prompts/summarize-system.md`.

`KRUSE_AI_SELECTION_MIN_PRIORITY=4` means low-priority selector items stay in
the audit but do not proceed into evidence/writing. This keeps thin one-liners
and clever-but-useless cards from wasting later tokens.

## Commands

From PowerShell on Windows, use `npm.cmd ...` if `npm ...` is blocked by the
script execution policy.

```bash
# Build HTML only. No sunrise check, no email.
npm run build

# Same as above, Windows PowerShell-safe.
npm.cmd run build

# Build the AI input JSON manually.
npm run build-input -- 2026-05-24

# Build HTML using AI. This auto-builds curated/<date>-input.json first.
npm run build-ai -- --date=2026-05-24

# Compare with the old one-shot AI prompt in PowerShell.
$env:KRUSE_AI_PIPELINE='single'; npm.cmd run build-ai -- --date=2026-05-24

# Normal scheduled behavior: build, check sunrise window, send only if allowed.
npm start

# Bypass sunrise and last-sent gates, then send.
npm run force-send

# Send the newest hand-authored v2 HTML as a pipeline smoke test.
npm run v2-test
```

## GitHub Actions Secrets

| Secret | Purpose |
|---|---|
| `XAPI_BEARER_TOKEN` | Used by the sibling Twitter scraper. |
| `GMAIL_USER` | Sending Gmail address. |
| `GMAIL_APP_PASSWORD` | Gmail app password, not the account password. |
| `ANTHROPIC_API_KEY` | Required only when the workflow uses `--use-ai`. |

## Notes

- `curated/<date>.json` is the renderer contract. The schema lives at
  `prompts/output-schema.json`.
- `curated/2026-05-24.json` is the current quality reference: it was manually
  curated after prompt feedback and should be treated as the target style for
  API-generated summaries.
- Failed AI parse/validation attempts save the raw model text to
  `out/<date>-ai-raw.txt`.
- If a model response is truncated, increase `ANTHROPIC_MAX_TOKENS` or tighten
  `prompts/summarize-system.md`.
