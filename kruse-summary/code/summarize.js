// Anthropic API caller: turn a day's compact input JSON into the curated
// summary JSON the renderer consumes.
//
// Default mode is an editorial prompt chain:
//   1. select   -> curated/<date>-selection-audit.json
//   2. evidence -> curated/<date>-evidence-notes.json
//   3. write    -> curated/<date>-draft.json
//   4. editor   -> curated/<date>.json
//
// Set KRUSE_AI_PIPELINE=single to preserve the old one-shot summarizer for
// comparison/debugging.

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
    throw new Error('ANTHROPIC_API_KEY not set - paste into .env or GH Actions secret.');
  }
  _client = new Anthropic({ apiKey: SETTINGS.anthropicApiKey });
  return _client;
}

function loadPrompt(filename) {
  return readFileSync(path.join(ROOT, 'prompts', filename), 'utf8');
}

function loadGoldenExamples() {
  return readFileSync(path.join(ROOT, 'prompts', 'examples', 'golden-deconstruction.md'), 'utf8');
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
function parseJsonResponse(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const cand = fenced ? fenced[1] : text;
  try { return JSON.parse(cand); } catch { /* fall through */ }

  const start = cand.indexOf('{');
  const end = cand.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(cand.slice(start, end + 1)); } catch { /* fall through */ }
  }

  const looksTruncated = start >= 0 && (end < start || !cand.trim().endsWith('}'));
  if (looksTruncated) {
    throw new Error('AI returned truncated JSON; increase ANTHROPIC_MAX_TOKENS or tighten prompts');
  }
  throw new Error('AI returned text that did not parse as JSON');
}

// Minimal structural validation - surface obvious schema breakage early.
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

function validateSelection(selection) {
  if (!selection || typeof selection !== 'object') throw new Error('selection must be an object');
  if (!Array.isArray(selection.selected_items)) throw new Error('selection.selected_items must be an array');
  if (!Array.isArray(selection.dropped_items)) throw new Error('selection.dropped_items must be an array');
}

function validateEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') throw new Error('evidence must be an object');
  if (!Array.isArray(evidence.card_notes)) throw new Error('evidence.card_notes must be an array');
  if (evidence.forum_notes && !Array.isArray(evidence.forum_notes)) throw new Error('evidence.forum_notes must be an array if present');
  if (evidence.rejected_after_review && !Array.isArray(evidence.rejected_after_review)) {
    throw new Error('evidence.rejected_after_review must be an array if present');
  }
}

function sanitizeText(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/\bdeuterium-loaded skin lattice\b/gi, "skin's water-rich extracellular matrix")
    .replace(/\bdeuterium-sludgified skin lattice\b/gi, "skin's deuterium-loaded extracellular matrix")
    .replace(/\bskin lattice\b/gi, "skin's extracellular matrix");
}

function sanitizeConceptMap(concepts = {}) {
  return Object.fromEntries(Object.entries(concepts).map(([term, value]) => {
    if (typeof value === 'string') return [term, sanitizeText(value)];
    if (!value || typeof value !== 'object') return [term, value];
    return [term, { ...value, text: sanitizeText(value.text) }];
  }));
}

function sanitizeSummary(summary) {
  const bannedQuotePattern = /\b(scammer|pure nonsense|lol|idiot|moron|grifter|fraud)\b/i;
  const sections = (summary.sections || []).map((section) => ({
    ...section,
    cards: (section.cards || []).map((card) => {
      const clean = {
        ...card,
        lead: sanitizeText(card.lead),
        body: sanitizeText(card.body),
        points: Array.isArray(card.points) ? card.points.map(sanitizeText) : card.points,
        concepts: sanitizeConceptMap(card.concepts),
        source_ids: (card.source_ids || []).filter(isTweetId),
      };
      if (typeof clean.source_quote === 'string') {
        clean.source_quote = sanitizeText(clean.source_quote);
        if (bannedQuotePattern.test(clean.source_quote)) delete clean.source_quote;
      }
      return clean;
    }),
  }));

  const forum = summary.forum ? {
    ...summary.forum,
    bullets: (summary.forum.bullets || []).map((bullet) => ({
      ...bullet,
      title: sanitizeText(bullet.title),
      summary: sanitizeText(bullet.summary),
      concepts: sanitizeConceptMap(bullet.concepts),
    })),
  } : undefined;

  return {
    ...summary,
    headline_subtitle: sanitizeText(summary.headline_subtitle),
    sections,
    ...(forum ? { forum } : {}),
  };
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function writeJsonArtifact(date, suffix, value) {
  const outDir = path.join(ROOT, 'curated');
  ensureDir(outDir);
  const outPath = path.join(outDir, `${date}-${suffix}.json`);
  writeFileSync(outPath, JSON.stringify(value, null, 2), 'utf8');
  info(`anthropic: wrote ${path.relative(ROOT, outPath)}`);
}

function isTweetId(id) {
  return typeof id === 'string' && /^\d{10,}$/.test(id);
}

function pruneSelectionForEvidence(selection) {
  const minPriority = SETTINGS.aiSelectionMinPriority;
  const selected = selection.selected_items || [];
  const strongItems = selected.filter((item) => (item.priority || 0) >= minPriority);
  const lowPriorityDrops = selected
    .filter((item) => (item.priority || 0) < minPriority)
    .map((item) => ({
      source_type: item.source_type,
      source_id: item.source_id,
      reason_category: 'below_priority_gate',
      reason: `Selected priority ${item.priority || 0}, below KRUSE_AI_SELECTION_MIN_PRIORITY=${minPriority}.`,
    }));

  if (lowPriorityDrops.length) {
    info(`anthropic: selector gate kept ${strongItems.length}/${selected.length} selected item(s); ${lowPriorityDrops.length} low-priority item(s) stay audit-only`);
  }

  return {
    ...selection,
    selected_items: strongItems,
    dropped_items: [...(selection.dropped_items || []), ...lowPriorityDrops],
  };
}

function prepareEvidenceForWriter(evidence) {
  const cardNotes = [];
  const forumNotes = [...(evidence.forum_notes || [])];

  for (const note of evidence.card_notes || []) {
    const ids = note.source_ids || [];
    const hasTweet = ids.some(isTweetId);
    if (hasTweet) {
      cardNotes.push({
        ...note,
        source_ids: ids.filter(isTweetId),
      });
      continue;
    }

    const threadUrl = (note.source_urls || []).find((u) => typeof u === 'string' && u.includes('forum.jackkruse.com'))
      || ids.find((id) => typeof id === 'string' && id.includes('forum.jackkruse.com'))
      || '';
    forumNotes.push({
      thread_url: threadUrl,
      title: note.lead_angle || note.tag || 'Forum update',
      summary_angle: note.claim || note.lead_angle || '',
      mechanism_or_case: [
        note.mechanism_notes,
        note.protocol_or_implication,
      ].filter(Boolean).join(' '),
      concepts_to_define: note.concepts_to_define || [],
    });
  }

  return {
    ...evidence,
    card_notes: cardNotes,
    forum_notes: forumNotes,
  };
}

function dumpRaw(date, label, text) {
  const dumpDir = path.join(ROOT, 'out');
  ensureDir(dumpDir);
  const dumpPath = path.join(dumpDir, `${date}-${label}-ai-raw.txt`);
  writeFileSync(dumpPath, text, 'utf8');
  warn(`raw ${label} response saved to ${path.relative(ROOT, dumpPath)} for inspection`);
}

async function callJsonStep(date, label, systemPrompt, userMessage, validator) {
  info(`anthropic:${label}: calling ${SETTINGS.anthropicModel} (max_tokens=${SETTINGS.anthropicMaxTokens})`);
  info(`anthropic:${label}: input ${(userMessage.length / 1024).toFixed(1)} KB, system ${(systemPrompt.length / 1024).toFixed(1)} KB`);

  const response = await client().messages.create({
    model: SETTINGS.anthropicModel,
    max_tokens: SETTINGS.anthropicMaxTokens,
    system: systemPrompt,
    temperature: 0.2,
    messages: [{ role: 'user', content: userMessage }],
  });

  const usage = response.usage || {};
  info(`anthropic:${label}: usage - input_tokens=${usage.input_tokens}, output_tokens=${usage.output_tokens}, cache_read=${usage.cache_read_input_tokens || 0}`);

  const text = response.content.map((b) => b.text || '').join('').trim();
  if (!text) throw new Error(`anthropic:${label}: empty response`);

  try {
    const parsed = parseJsonResponse(text);
    validator(parsed);
    return { parsed, usage };
  } catch (e) {
    error(`anthropic:${label}: parse/validate failed: ${e.message}`);
    dumpRaw(date, label, text);
    throw e;
  }
}

function formatUsageTotals(usages) {
  const totals = usages.reduce((acc, u = {}) => {
    acc.input_tokens += u.input_tokens || 0;
    acc.output_tokens += u.output_tokens || 0;
    acc.cache_read_input_tokens += u.cache_read_input_tokens || 0;
    return acc;
  }, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 });
  return `input_tokens=${totals.input_tokens}, output_tokens=${totals.output_tokens}, cache_read=${totals.cache_read_input_tokens}`;
}

async function summarizeDaySingle(date, { dryRun = false } = {}) {
  const systemPrompt = loadPrompt('summarize-system.md');
  const input = loadInput(date);
  const userMessage = `Here is the day's content as a JSON object. Produce the curated summary JSON per your system instructions.\n\n${JSON.stringify(input, null, 2)}`;
  const { parsed: summary } = await callJsonStep(date, 'single', systemPrompt, userMessage, validateSummary);

  if (!dryRun) {
    const outPath = path.join(ROOT, 'curated', `${date}.json`);
    writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');
    info(`anthropic: wrote ${path.relative(ROOT, outPath)}`);
  }
  return summary;
}

async function summarizeDayChain(date, { dryRun = false } = {}) {
  const input = loadInput(date);
  const examples = loadGoldenExamples();
  const usages = [];

  const selectionUser = [
    'Golden deconstruction examples:',
    examples,
    '',
    "Here is the day's 24-hour source JSON. Select and drop items per your instructions.",
    JSON.stringify(input, null, 2),
  ].join('\n');
  const selectionResult = await callJsonStep(date, 'select', loadPrompt('select-system.md'), selectionUser, validateSelection);
  usages.push(selectionResult.usage);
  const selection = selectionResult.parsed;
  writeJsonArtifact(date, 'selection-audit', selection);
  const gatedSelection = pruneSelectionForEvidence(selection);
  if (gatedSelection !== selection) writeJsonArtifact(date, 'selection-gated', gatedSelection);

  const evidenceUser = [
    'Golden deconstruction examples:',
    examples,
    '',
    'Original source JSON:',
    JSON.stringify(input, null, 2),
    '',
    'Selection audit:',
    JSON.stringify(gatedSelection, null, 2),
  ].join('\n');
  const evidenceResult = await callJsonStep(date, 'evidence', loadPrompt('evidence-system.md'), evidenceUser, validateEvidence);
  usages.push(evidenceResult.usage);
  const evidence = prepareEvidenceForWriter(evidenceResult.parsed);
  writeJsonArtifact(date, 'evidence-notes', evidence);

  const draftUser = [
    'Golden deconstruction examples:',
    examples,
    '',
    'Evidence notes:',
    JSON.stringify(evidence, null, 2),
  ].join('\n');
  const draftResult = await callJsonStep(date, 'write', loadPrompt('write-system.md'), draftUser, validateSummary);
  usages.push(draftResult.usage);
  const draft = draftResult.parsed;
  writeJsonArtifact(date, 'draft', draft);

  const editorUser = [
    'Golden deconstruction examples:',
    examples,
    '',
    'Evidence notes:',
    JSON.stringify(evidence, null, 2),
    '',
    'Draft renderer JSON:',
    JSON.stringify(draft, null, 2),
  ].join('\n');
  const finalResult = await callJsonStep(date, 'editor', loadPrompt('editor-system.md'), editorUser, validateSummary);
  usages.push(finalResult.usage);
  const summary = sanitizeSummary(finalResult.parsed);
  validateSummary(summary);

  info(`anthropic: chained usage totals - ${formatUsageTotals(usages)}`);

  if (!dryRun) {
    const outPath = path.join(ROOT, 'curated', `${date}.json`);
    writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');
    info(`anthropic: wrote ${path.relative(ROOT, outPath)}`);
  }
  return summary;
}

// Returns the parsed summary JSON. Also writes it to curated/<date>.json
// unless `dryRun` is true.
export async function summarizeDay(date, { dryRun = false } = {}) {
  if (SETTINGS.aiPipeline === 'single') {
    warn('KRUSE_AI_PIPELINE=single: using legacy one-shot AI summarizer');
    return summarizeDaySingle(date, { dryRun });
  }
  if (SETTINGS.aiPipeline !== 'chain') {
    throw new Error(`Unknown KRUSE_AI_PIPELINE=${SETTINGS.aiPipeline}; use "chain" or "single"`);
  }
  return summarizeDayChain(date, { dryRun });
}
