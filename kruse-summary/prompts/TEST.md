# Manual AI test workflow

Use this to validate the summarizer prompt against today's data BEFORE
buying API tokens. Costs $0 — uses the free web chat of any major LLM.

## What you need

1. **System prompt**: [`summarize-system.md`](summarize-system.md)
2. **Today's input JSON**: `curated/<YYYY-MM-DD>-input.json`
   (regenerate any day with `node code/build-input.js [YYYY-MM-DD]`)
3. A free chat account with Claude / ChatGPT / Gemini / DeepSeek

## Steps

1. Open the chat. Start a new conversation.
2. Paste the entire content of `summarize-system.md` as the FIRST message.
   Add at the bottom: *"Acknowledge — say only 'ready'."* (so the model
   doesn't try to summarize immediately).
3. Paste the content of `curated/<DATE>-input.json` as the SECOND message.
4. Model returns structured JSON.
5. Save its JSON output to `curated/<DATE>.json` (note: no `-input` suffix).
6. Render to HTML:
   ```
   cd kruse-summary
   INCLUDE_FORUM=true node main.js --build-only --date=<DATE>
   ```
7. Open `out/<DATE>.html` in a browser. Try the `Noob / Pro / Hacker`
   toggle. Verify chip-gating works.

## Iterate

If the model's curation looks wrong, edit `summarize-system.md` and
re-run the test in a fresh chat. Cost stays $0 on free tiers.

## Recommended models (as of 2026-05)

| Model | Provider | Input cost (per 1M tokens) | Output cost (per 1M tokens) | Verdict |
|---|---|---|---|---|
| **Claude Haiku 4.5** | Anthropic | $1.00 | $5.00 | **Recommended** — best balance for technical biophysics + curation nuance. Strong at "don't add bullets when nothing meets bar." Native structured JSON output. |
| Claude Sonnet 4.5 | Anthropic | $3.00 | $15.00 | If quality at any cost — fewer misses on subtle skip-vs-keep calls. Probably overkill. |
| GPT-4o-mini | OpenAI | $0.15 | $0.60 | Cheapest brand-name. Good basic structured output. Slightly weaker at "this restated position should be skipped." |
| DeepSeek V3 | DeepSeek | $0.27 | $1.10 | Cheapest with serious quality. Open-weight. Sometimes too eager to add bullets. |
| Gemini 2.5 Flash | Google | $0.30 | $2.50 | Decent. Free tier has strict rate limits. |

### Expected per-day cost on Haiku 4.5

- System prompt: ~3 K input tokens
- Today's input JSON: ~3 K input tokens (10 KB)
- Output JSON: ~2-4 K output tokens
- **Total ≈ $0.02 per day → ~$0.60/mo**

Anthropic gives **$5 free credit** on signup → ~250 daily runs covered.

## When you're ready to wire it into the cron

Tell me. I'll add `code/summarize.js` that calls the chosen API,
replaces the manual paste step, and adds an `ANTHROPIC_API_KEY` (or
equivalent) secret to the GH workflow.
