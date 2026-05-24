# Prompts

Files loaded at runtime by `code/summarize.js` when calling the Anthropic API
to summarize a day's tweets and forum updates.

## Files

| File | Role |
|---|---|
| `select-system.md` | Pass 1: keep/drop every source item before writing |
| `evidence-system.md` | Pass 2: convert kept items into claim/mechanism/evidence notes |
| `write-system.md` | Pass 3: write renderer-facing summary JSON draft |
| `editor-system.md` | Pass 4: final quality referee; removes vague/generic cards |
| `examples/golden-deconstruction.md` | Contrastive few-shot examples: why good cards work and bad cards fail |
| `summarize-system.md` | Legacy one-shot prompt, used only with `KRUSE_AI_PIPELINE=single` |
| `output-schema.json` | Renderer-facing summary contract |

## How They Get Used

Default `KRUSE_AI_PIPELINE=chain`:

1. `select-system.md` reads the full 24-hour input and writes
   `curated/<date>-selection-audit.json`.
2. `evidence-system.md` reads the original input plus selected items and writes
   `curated/<date>-evidence-notes.json`.
3. `write-system.md` writes `curated/<date>-draft.json`.
4. `editor-system.md` returns final `curated/<date>.json`.

Set `KRUSE_AI_PIPELINE=single` to use `summarize-system.md` directly.

## Editing

Iterate prompts freely. The final renderer schema is the contract, so keep
`build-report.js` in sync if you change `sections[].cards[]` shape.

The golden examples should stay compact. They are there to teach the quality
boundary, not to act as source material for new reports.
