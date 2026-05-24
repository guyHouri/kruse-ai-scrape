# kruse-summary - AI assistant notes

Public docs: `README.md`.

This module is a standalone daily newsletter pipeline. It reads normalized
daily tweets from `../twitter_to_md/data`, optionally reads forum daily JSON
from `../forum_to_md/daily`, renders `out/<date>.html`, and can send the report
through Gmail SMTP.

## Runtime Flow

`main.js` is the only orchestrator:

1. Parse flags and choose report date, defaulting to the current UTC day.
2. Skip duplicate sends via `last-sent.json` unless `--force` or `--build-only`.
3. If `--use-ai`, build `curated/<date>-input.json` from the rolling
   `SUMMARY_WINDOW_HOURS` tweet/forum window, then call `summarizeDay(date)`.
   The default `KRUSE_AI_PIPELINE=chain` path runs selector -> evidence notes
   -> writer -> editor.
4. Otherwise load `curated/<date>.json` if present.
5. Render HTML through `buildReportHtml(date, summary)`.
6. In send mode, check sunrise window and email the report.

`--use-ai` is self-contained now: `code/summarize.js` auto-builds
`curated/<date>-input.json` through `code/build-input.js` when the input file is
missing.

## Code Map

| File | Purpose |
|---|---|
| `main.js` | CLI/orchestrator: build, AI, sunrise gate, send, mark state |
| `settings.js` | Env-driven paths, Gmail, location, Anthropic knobs |
| `code/build-input.js` | Compact twitter/forum JSON into AI input |
| `code/compact.js` | Drop noisy tweet fields before LLM call |
| `code/summarize.js` | Anthropic prompt chain, JSON parse/validation, raw dumps |
| `code/build-report.js` | Curated/raw summary renderer to standalone HTML |
| `code/sunrise.js` | Sunrise API and target-window calculation |
| `code/email.js` | Nodemailer Gmail SMTP with BCC recipients |
| `code/state.js` | `last-sent.json` read/write |

## Failure Modes

- `npm` may fail in PowerShell because `npm.ps1` is blocked. Use `npm.cmd`.
- Missing scraped tweet JSON is a real input error; fix the source scrape first.
- Missing AI input JSON is not an error; `summarize.js` now builds it.
- Forum bullets render by default; set `INCLUDE_FORUM=false` only for a hidden
  forum preview.
- Sunrise API/network failure should not crash the scheduled job. `main.js`
  skips sending so the next cron run can retry.
- Chained AI runs write inspectable intermediates:
  `curated/<date>-selection-audit.json`,
  `curated/<date>-selection-gated.json`,
  `curated/<date>-evidence-notes.json`, and `curated/<date>-draft.json`.
  `KRUSE_AI_SELECTION_MIN_PRIORITY` defaults to 4; lower-priority selected
  items remain in the audit but do not proceed to writing.
- AI JSON parse/validation failures write `out/<date>-<step>-ai-raw.txt`;
  inspect that file before making another API call.
- Truncated AI JSON usually means the response hit `ANTHROPIC_MAX_TOKENS` or
  the prompt allowed too much output.
- `curated/2026-05-24.json` is the quality reference. It was manually curated
  after user feedback, not merely accepted from a one-shot API run.

## Generated Files

Avoid reading large generated files unless needed:

- `out/*.html`
- `out/*-ai-raw.txt`
- `curated/*-selection-audit.json`
- `curated/*-selection-gated.json`
- `curated/*-evidence-notes.json`
- `curated/*-draft.json`
- large `curated/*-input.json`

Small curated summaries are okay to inspect when debugging renderer behavior.
