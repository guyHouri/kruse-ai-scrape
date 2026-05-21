# Prompts

Files loaded at runtime by `code/build-report.js` (TODO wiring) when calling
the Anthropic API to summarize a day's tweets.

## Files

| File | Role |
|---|---|
| `summarize-system.md` | System prompt — model instructions, input/output schema |
| `output-schema.json` | JSON Schema validating the model's returned summary |

## How they get used (planned)

```js
// pseudocode inside code/build-report.js
import { loadAndCompact } from './compact.js';
const compact = loadAndCompact(date);
const system = readFileSync('prompts/summarize-system.md', 'utf8');
const resp = await anthropic.messages.create({
  model: 'claude-haiku-4-5-20251001',
  system,
  messages: [{ role: 'user', content: JSON.stringify(compact) }],
  max_tokens: 4000,
});
const summary = JSON.parse(resp.content[0].text);
validate(summary, outputSchema);   // ajv or similar
const html = renderSummaryHtml(summary, compact);
```

## Editing

Iterate the system prompt freely. The schema is the contract — keep
`build-report.js` renderer in sync if you change `sections[].cards[]` shape.

## NOT a Claude Code skill

These are plain prompt files for an SDK call. If you also want a Claude Code
slash-command skill for interactive prompt iteration, place it at
`.claude/skills/kruse-summarize/SKILL.md` instead — that's a separate concept
and not required for the production cron.
