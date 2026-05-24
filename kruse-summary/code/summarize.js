// Anthropic API caller: turn a day's compact input JSON into the curated
// summary JSON the renderer consumes.
//
// Loads:
//   - System prompt:   prompts/summarize-system.md
//   - Daily input:     curated/<date>-input.json  (built by code/build-input.js)
//
// Calls Claude (default model: claude-haiku-4-5) and parses the JSON response.
// Saves the curated output to curated/<date>.json so main.js's auto-discovery
// renders it.
//
// Cost guard: hard-fails if input + max_tokens would exceed `SETTINGS.maxAiCostUsd`
// (currently no implicit cap; the model returns at most maxTokens output).

import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS } from '../settings.js';
import { info, warn, error } from './logger.js';
import { buildInputFile } from './build-input.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let _client = null;
function client() {
  if (_client) return _client;
  if (!SETTINGS.anthropicApiKey) {
    throw new Error('ANTHROPIC_API_KEY not set — paste into .env or GH Actions secret.');
  }
  _client = new Anthropic({ apiKey: SETTINGS.anthropicApiKey });
  return _client;
}

function loadSystemPrompt() {
  const p = path.join(ROOT, 'prompts', 'summarize-system.md');
  return readFileSync(p, 'utf8');
}

function loadInput(date) {
  const p = path.join(ROOT, 'curated', `${date}-input.json`);
  if (!existsSync(p)) {
    warn(`input JSON not found at ${p}; building it now`);
    buildInputFile(date);
  }
  return JSON.parse(readFileSync(p, 'utf8'));
}

// Defensive parse: try direct JSON, fall back to extracting a fenced block
// or the largest {...} substring. Anthropic models on this task return clean
// JSON the vast majority of the time, but be tolerant.
function parseSummaryJson(text) {
  // Strip ```json fences if present.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const cand = fenced ? fenced[1] : text;
  try { return JSON.parse(cand); } catch { /* fall through */ }
  // Last-ditch: find the largest top-level object.
  const start = cand.indexOf('{');
  const end = cand.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(cand.slice(start, end + 1)); } catch { /* fall through */ }
  }
  const looksTruncated = start >= 0 && (end < start || !cand.trim().endsWith('}'));
  if (looksTruncated) {
    throw new Error('AI returned truncated JSON; increase ANTHROPIC_MAX_TOKENS or tighten prompts/summarize-system.md');
  }
  throw new Error('AI returned text that did not parse as JSON');
}

// Minimal structural validation — surface obvious schema breakage early.
function validateSummary(summary) {
  if (!summary || typeof summary !== 'object') throw new Error('summary must be an object');
  if (typeof summary.headline_subtitle !== 'string') throw new Error('missing headline_subtitle');
  if (!Array.isArray(summary.sections) || !summary.sections.length) throw new Error('missing sections[]');
  for (const sec of summary.sections) {
    if (!sec.title) throw new Error('section missing title');
    if (!Array.isArray(sec.cards)) throw new Error(`section "${sec.title}" missing cards[]`);
    for (const c of sec.cards) {
      if (!c.lead) throw new Error('card missing lead');
      if (!c.body) throw new Error('card missing body');
      if (!Array.isArray(c.source_ids) || !c.source_ids.length) throw new Error(`card "${c.lead}" missing source_ids`);
    }
  }
  if (summary.forum && !Array.isArray(summary.forum.bullets)) {
    throw new Error('forum.bullets must be an array if forum is present');
  }
}

// Returns the parsed summary JSON. Also writes it to curated/<date>.json
// unless `dryRun` is true.
export async function summarizeDay(date, { dryRun = false } = {}) {
  const systemPrompt = loadSystemPrompt();
  const input = loadInput(date);
  const userMessage = `Here is the day's content as a JSON object. Produce the curated summary JSON per your system instructions.\n\n${JSON.stringify(input, null, 2)}`;

  info(`anthropic: calling ${SETTINGS.anthropicModel} (max_tokens=${SETTINGS.anthropicMaxTokens})`);
  info(`anthropic: input ${(userMessage.length / 1024).toFixed(1)} KB, system ${(systemPrompt.length / 1024).toFixed(1)} KB`);

  const response = await client().messages.create({
    model: SETTINGS.anthropicModel,
    max_tokens: SETTINGS.anthropicMaxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const usage = response.usage || {};
  info(`anthropic: usage — input_tokens=${usage.input_tokens}, output_tokens=${usage.output_tokens}, cache_read=${usage.cache_read_input_tokens || 0}`);

  // Concatenate text from all content blocks (usually just one).
  const text = response.content.map((b) => b.text || '').join('').trim();
  if (!text) throw new Error('anthropic: empty response');

  let summary;
  try {
    summary = parseSummaryJson(text);
    validateSummary(summary);
  } catch (e) {
    error(`anthropic: parse/validate failed: ${e.message}`);
    // Dump raw response so we can iterate the prompt.
    const dumpDir = path.join(ROOT, 'out');
    if (!existsSync(dumpDir)) mkdirSync(dumpDir, { recursive: true });
    const dumpPath = path.join(dumpDir, `${date}-ai-raw.txt`);
    writeFileSync(dumpPath, text, 'utf8');
    warn(`raw response saved to ${path.relative(ROOT, dumpPath)} for inspection`);
    throw e;
  }

  if (!dryRun) {
    const outPath = path.join(ROOT, 'curated', `${date}.json`);
    writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');
    info(`anthropic: wrote ${path.relative(ROOT, outPath)}`);
  }
  return summary;
}
