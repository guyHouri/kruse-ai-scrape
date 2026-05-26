// Anthropic API caller: turn a day's compact input JSON into the curated
// summary JSON the renderer consumes.
//
// Current workflow:
//   1. curate -> curated/<date>-selection-audit.json
//   2. gate   -> curated/<date>-selection-gated.json
//   3. write  -> curated/<date>-draft.json
//   4. explain science -> curated/<date>-explained.json
//   5. verify -> curated/<date>-verification.json

import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS } from '../settings.js';
import { info, warn, error } from './logger.js';
import { buildInputFile } from './build-input.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REDUNDANT_CONCEPTS = new Set([
  'decentralized medicine',
  'biophysics of patients',
  'redox',
  'nnemf',
  'grounding',
  'deuterium',
  'magnetism',
  'dha',
  'leptin rx',
  'sunrise',
  'blue blockers',
]);
const KRUSE_PRIVATE_PHRASES = [
  'water table de-fragging',
  'water-table de-fragging',
  'de-fragging the water table',
  'internal water table collapse',
  'water table collapse',
  'skin lattice',
  'lattice lock',
  'optical switch',
  'water de-fragging',
  'de-fragging',
];

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
  const expectedSectionTitles = ['Twitter Updates', 'Forum Updates'];
  const actualSectionTitles = summary.sections.map((sec) => sec.title);
  if (actualSectionTitles.length !== expectedSectionTitles.length
    || actualSectionTitles.some((title, i) => title !== expectedSectionTitles[i])) {
    throw new Error(`sections must be exactly: ${expectedSectionTitles.join(' -> ')}`);
  }
  for (const sec of summary.sections) {
    if (!sec.title) throw new Error('section missing title');
    if (!Array.isArray(sec.cards)) throw new Error(`section "${sec.title}" missing cards[]`);
    for (const c of sec.cards) {
      if (!c.lead) throw new Error('card missing lead');
      if (!c.body) throw new Error('card missing body');
      const hasSourceIds = Array.isArray(c.source_ids) && c.source_ids.length;
      const hasSourceUrls = Array.isArray(c.source_urls) && c.source_urls.length;
      if (!hasSourceIds && !hasSourceUrls) {
        throw new Error(`card "${c.lead}" missing source_ids/source_urls`);
      }
      if (sec.title === 'Twitter Updates' && !hasSourceIds) throw new Error(`Twitter card "${c.lead}" missing source_ids`);
      if (sec.title === 'Forum Updates' && !hasSourceUrls) throw new Error(`Forum card "${c.lead}" missing source_urls`);
    }
  }
  if (summary.forum && !Array.isArray(summary.forum.bullets)) {
    throw new Error('forum.bullets must be an array if forum is present');
  }
  if (summary.forum?.bullets?.length) {
    throw new Error('forum.bullets must stay empty; forum signal belongs in normal cards');
  }
}

function normalizeArray(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

function normalizeCitations(value) {
  return Array.isArray(value)
    ? value.map((citation) => ({
      paper: String(citation?.paper || ''),
      claim: String(citation?.claim || ''),
    }))
    : [];
}

function validateExplanationPreservesDraft(draft, explained) {
  const errors = [];
  if ((draft.sections || []).length !== (explained.sections || []).length) {
    errors.push('section count changed');
  }

  const sectionCount = Math.min(draft.sections?.length || 0, explained.sections?.length || 0);
  for (let s = 0; s < sectionCount; s++) {
    const beforeSection = draft.sections[s];
    const afterSection = explained.sections[s];
    if (beforeSection.title !== afterSection.title) {
      errors.push(`section ${s} title changed from "${beforeSection.title}" to "${afterSection.title}"`);
    }
    if ((beforeSection.cards || []).length !== (afterSection.cards || []).length) {
      errors.push(`section "${beforeSection.title}" card count changed`);
      continue;
    }
    for (let c = 0; c < (beforeSection.cards || []).length; c++) {
      const before = beforeSection.cards[c];
      const after = afterSection.cards[c];
      const label = before.lead || `${beforeSection.title} card ${c + 1}`;
      for (const field of ['tag', 'lead', 'source_quote']) {
        if (String(before[field] || '') !== String(after[field] || '')) {
          errors.push(`card "${label}" changed ${field}`);
        }
      }
      if (JSON.stringify(normalizeArray(before.source_ids)) !== JSON.stringify(normalizeArray(after.source_ids))) {
        errors.push(`card "${label}" changed source_ids`);
      }
      if (JSON.stringify(normalizeArray(before.source_urls)) !== JSON.stringify(normalizeArray(after.source_urls))) {
        errors.push(`card "${label}" changed source_urls`);
      }
      if (JSON.stringify(normalizeCitations(before.citations)) !== JSON.stringify(normalizeCitations(after.citations))) {
        errors.push(`card "${label}" changed citations`);
      }
    }
  }

  if (JSON.stringify(draft.forum || { bullets: [] }) !== JSON.stringify(explained.forum || { bullets: [] })) {
    errors.push('forum object changed');
  }

  if (errors.length) throw new Error(`science explanation changed protected fields:\n- ${errors.join('\n- ')}`);
}

function validateSelection(selection) {
  if (!selection || typeof selection !== 'object') throw new Error('selection must be an object');
  if (!Array.isArray(selection.selected_items)) throw new Error('selection.selected_items must be an array');
  if (!Array.isArray(selection.dropped_items) && !Array.isArray(selection.unselected_items)) {
    throw new Error('selection must include dropped_items[] or unselected_items[]');
  }
  const watchlist = selection.selected_items.filter((item) => item?.value_type === 'watchlist');
  if (watchlist.length) {
    throw new Error(`selection cannot include watchlist/question cards: ${watchlist.map((item) => item.source_id).join(', ')}`);
  }
}

function normalizeSelectionSourceId(item) {
  return String(item?.source_id || '').replace(/^thread_url:\s*/i, '').trim();
}

function forumSelectionId(value) {
  const text = String(value || '').trim();
  const match = text.match(/\/threads\/[^/]*\.(\d+)(?:\/|$)/i);
  return match ? match[1] : text;
}

function selectionKey(item) {
  const type = item?.source_type;
  const id = normalizeSelectionSourceId(item);
  if (type === 'tweet') return `tweet:${id}`;
  if (type === 'forum') return `forum:${forumSelectionId(id)}`;
  return `${type || 'unknown'}:${id}`;
}

function inputSourceKeys(input) {
  return new Set([
    ...(input?.twitter?.tweets || []).map((tweet) => `tweet:${String(tweet.id)}`),
    ...(input?.forum?.posts || []).map((post) => `forum:${forumSelectionId(post.thread_url)}`),
  ].filter((key) => !key.endsWith(':')));
}

function validateSelectionCoverage(input, selection) {
  const expected = inputSourceKeys(input);
  const seen = new Map();
  const allItems = [
    ...(selection.selected_items || []),
    ...(selection.unselected_items || selection.dropped_items || []),
  ];
  for (const item of allItems) {
    const key = selectionKey(item);
    if (!key || /^(tweet|forum):$/.test(key)) continue;
    seen.set(key, (seen.get(key) || 0) + 1);
  }

  const missing = [...expected].filter((key) => !seen.has(key));
  const duplicate = [...seen.entries()].filter(([, count]) => count > 1).map(([key]) => key);
  const extra = [...seen.keys()].filter((key) => !expected.has(key));
  const errors = [];
  if (missing.length) errors.push(`missing classifications: ${missing.join(', ')}`);
  if (duplicate.length) errors.push(`duplicate classifications: ${duplicate.join(', ')}`);
  if (extra.length) errors.push(`classifications not in input: ${extra.join(', ')}`);
  if (errors.length) throw new Error(`selection coverage failed:\n- ${errors.join('\n- ')}`);
}

function inputBlogRefsForSelectionItem(input, item) {
  if (item?.source_type === 'tweet') {
    const tweet = (input?.twitter?.tweets || []).find((t) => String(t.id) === String(item.source_id));
    return tweet?.blog_refs || [];
  }
  if (item?.source_type === 'forum') {
    const itemKey = forumSelectionId(item.source_url || item.source_id);
    const post = (input?.forum?.posts || []).find((p) => forumSelectionId(p.thread_url) === itemKey);
    return post?.blog_refs || [];
  }
  return [];
}

function attachInputBlogRefs(selection, input) {
  return {
    ...selection,
    selected_items: (selection.selected_items || []).map((item) => {
      const refs = item.blog_refs?.length ? item.blog_refs : inputBlogRefsForSelectionItem(input, item);
      return refs.length ? { ...item, blog_refs: refs } : item;
    }),
  };
}

function inputTweetIds(input) {
  return new Set((input?.twitter?.tweets || []).map((t) => String(t.id)));
}

function inputForumUrls(input) {
  return new Set((input?.forum?.posts || []).map((p) => String(p.thread_url || '')).filter(Boolean));
}

function isForumUrl(value) {
  return /^https?:\/\/forum\.jackkruse\.com\//i.test(String(value || ''));
}

function normalizeSupportText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function sourceTextForTweetIds(input, sourceIds = []) {
  const wanted = new Set(sourceIds.map(String));
  return (input?.twitter?.tweets || [])
    .filter((tweet) => wanted.has(String(tweet.id)))
    .map((tweet) => [
      tweet.text,
      tweet.quoted?.text,
      tweet.quoted_tweet?.text,
      ...(Array.isArray(tweet.reply_chain) ? tweet.reply_chain.map((reply) => reply.text) : []),
    ].filter(Boolean).join(' '))
    .join(' ');
}

function sourceTextForForumUrls(input, sourceUrls = []) {
  const wanted = new Set(sourceUrls.map(String));
  return (input?.forum?.posts || [])
    .filter((post) => wanted.has(String(post.thread_url)))
    .map((post) => [
      post.thread_title,
      post.author,
      post.forum_name,
      post.content,
    ].filter(Boolean).join(' '))
    .join(' ');
}

function sourceTextForCard(input, card) {
  return [
    sourceTextForTweetIds(input, card.source_ids || []),
    sourceTextForForumUrls(input, card.source_urls || []),
  ].filter(Boolean).join(' ');
}

function normalizeCitation(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function selectionCitationSet(selection) {
  const citations = new Set();
  for (const item of selection?.selected_items || []) {
    for (const citation of item.source_citations || []) {
      const key = normalizeCitation(citation.paper);
      if (key) citations.add(key);
    }
  }
  return citations;
}

function isAllowedCitation(citation, allowedCitations) {
  const key = normalizeCitation(citation.paper);
  if (!key) return false;
  const keyTokens = key.split(' ').filter((t) => t.length > 2 || /^\d{4}$/.test(t));
  return [...allowedCitations].some((allowed) => {
    if (allowed === key || allowed.includes(key) || key.includes(allowed)) return true;
    if (keyTokens.length < 2) return false;
    const hits = keyTokens.filter((token) => allowed.includes(token)).length;
    return hits / keyTokens.length >= 0.75;
  });
}

function validateSummaryProvenance(summary, input, podcastQueue = [], selection = null) {
  const ids = inputTweetIds(input);
  const forumUrls = inputForumUrls(input);
  const podcastIds = new Set(podcastQueue.map((p) => String(p.source_id)));
  const allowedCitations = selectionCitationSet(selection);
  const errors = [];

  for (const section of summary.sections || []) {
    for (const card of section.cards || []) {
      const cardHasTweetIds = Array.isArray(card.source_ids) && card.source_ids.length;
      const cardForumUrls = (card.source_urls || []).filter(isForumUrl);
      if (!cardHasTweetIds && !cardForumUrls.length) {
        errors.push(`card "${card.lead}" has no verifiable same-day tweet id or forum URL`);
      }
      for (const id of card.source_ids || []) {
        if (!ids.has(String(id))) errors.push(`card "${card.lead}" uses source_id not in input: ${id}`);
        if (podcastIds.has(String(id))) errors.push(`card "${card.lead}" uses deferred podcast source_id: ${id}`);
      }
      for (const url of cardForumUrls) {
        if (!forumUrls.has(String(url))) errors.push(`card "${card.lead}" uses forum URL not in input: ${url}`);
      }
      if (!card.source_quote) {
        errors.push(`card "${card.lead}" is missing source_quote`);
      } else {
        const sourceText = normalizeSupportText(sourceTextForCard(input, card));
        const quoteText = normalizeSupportText(card.source_quote);
        if (quoteText && sourceText && !sourceText.includes(quoteText)) {
          errors.push(`card "${card.lead}" has source_quote not found in same-day source text`);
        }
      }
      if (Array.isArray(card.citations) && card.citations.length) {
        for (const citation of card.citations) {
          const citationText = `${citation.paper || ''} ${citation.claim || ''}`.trim();
          if (/Kruse tweet|podcast pointer|Podcast linked|\bCPC\s*#?\d+|forum thread|blog post|source link|podcast title/i.test(citationText)) {
            errors.push(`card "${card.lead}" has pseudo-citation: ${citation.paper}`);
          }
          if (!isAllowedCitation(citation, allowedCitations)) {
            errors.push(`card "${card.lead}" cites paper not present in source_citations: ${citation.paper}`);
          }
        }
      }
    }
  }

  for (const bullet of summary.forum?.bullets || []) {
    if (bullet.thread_url && !forumUrls.has(String(bullet.thread_url))) {
      errors.push(`forum bullet "${bullet.title}" uses thread_url not in input: ${bullet.thread_url}`);
    }
  }

  if (errors.length) throw new Error(`summary provenance failed:\n- ${errors.join('\n- ')}`);
}

function normalizeForumUrlForMatch(value) {
  return forumSelectionId(value);
}

function selectedItemMatchesCard(item, card) {
  if (item.source_type === 'tweet') {
    const ids = new Set((card.source_ids || []).map(String));
    return ids.has(String(item.source_id));
  }
  if (item.source_type === 'forum') {
    const itemKey = normalizeForumUrlForMatch(item.source_url || item.source_id);
    return (card.source_urls || []).some((url) => normalizeForumUrlForMatch(url) === itemKey);
  }
  return false;
}

function repairSummarySourceQuotes(summary, input, selection) {
  const repaired = {
    ...summary,
    sections: (summary.sections || []).map((section) => ({
      ...section,
      cards: (section.cards || []).map((card) => ({ ...card })),
    })),
  };
  let repairCount = 0;

  for (const section of repaired.sections || []) {
    for (const card of section.cards || []) {
      const sourceText = normalizeSupportText(sourceTextForCard(input, card));
      const quoteText = normalizeSupportText(card.source_quote);
      if (quoteText && sourceText.includes(quoteText)) continue;

      const selected = (selection?.selected_items || []).find((item) => selectedItemMatchesCard(item, card));
      const replacement = (selected?.support_quotes || [])
        .find((quote) => sourceText.includes(normalizeSupportText(quote)));
      if (replacement) {
        card.source_quote = replacement;
        repairCount++;
      }
    }
  }

  if (repairCount) info(`anthropic: repaired ${repairCount} source_quote(s) from curator support_quotes`);
  return repaired;
}

function validateReportVoice(summary) {
  const banned = /\b(my read|wrong|right|uncited|no citation|without citation|not proven|unsupported|speculative|fake|AI BS|Codex|Anthropic|without mechanism|no mechanism|without trial|no trial|does not provide mechanism|does not provide dosing|mechanism or dosing detail|not standard|standard of care|efficacy or safety advantage|stronger evidence base|trial data (?:was )?not provided|not provided in (?:the )?source|likely refers|possibly|may refer|important for cellular health)\b/i;
  const fields = [];
  for (const section of summary.sections || []) {
    for (const card of section.cards || []) {
      fields.push(['headline_subtitle', summary.headline_subtitle]);
      fields.push([`card "${card.lead}" lead`, card.lead]);
      fields.push([`card "${card.lead}" body`, card.body]);
      for (const point of card.points || []) fields.push([`card "${card.lead}" point`, point]);
      for (const [term, value] of Object.entries(card.concepts || {})) {
        fields.push([`card "${card.lead}" concept ${term}`, typeof value === 'string' ? value : value?.text]);
      }
    }
  }
  const errors = fields
    .filter(([, text]) => banned.test(String(text || '')))
    .map(([label]) => label);
  if (errors.length) throw new Error(`report voice failed banned absence/opinion language:\n- ${errors.join('\n- ')}`);
}

function validateNoQuestionFraming(summary) {
  const bannedQuestionPhrases = /\b(a member asks|member asks|the useful signal is the question|question to track|watch for Jack'?s answer|track this question|unanswered question|what would make it useful later)\b/i;
  const errors = [];
  for (const section of summary.sections || []) {
    for (const card of section.cards || []) {
      const fields = [
        ['lead', card.lead],
        ['body', card.body],
        ...(Array.isArray(card.points) ? card.points.map((point, i) => [`point ${i + 1}`, point]) : []),
      ];
      for (const [field, text] of fields) {
        const value = String(text || '');
        if (value.includes('?')) errors.push(`card "${card.lead}" ${field} contains a question mark`);
        if (/\*\*\s*(Question|Watch|Follow-up|Context)\s*\.\s*\*\*/i.test(value)) {
          errors.push(`card "${card.lead}" ${field} uses banned question/watch label`);
        }
        if (bannedQuestionPhrases.test(value)) {
          errors.push(`card "${card.lead}" ${field} uses question/watchlist framing`);
        }
      }
    }
  }
  if (errors.length) throw new Error(`question framing failed:\n- ${errors.join('\n- ')}`);
}

function validatePrivatePhraseExplanations(summary) {
  const errors = [];
  for (const section of summary.sections || []) {
    for (const card of section.cards || []) {
      const visible = conceptKey([
        card.lead,
        card.body,
        ...(Array.isArray(card.points) ? card.points : []),
      ].filter(Boolean).join(' '));
      for (const phrase of KRUSE_PRIVATE_PHRASES) {
        const key = conceptKey(phrase);
        if (!visible.includes(key)) continue;
        if (!conceptMapCoversTerm(card.concepts || {}, phrase)) {
          errors.push(`card "${card.lead}" uses private phrase "${phrase}" without a concept explanation`);
        }
      }
    }
  }
  if (errors.length) throw new Error(`private phrase explanation failed:\n- ${errors.join('\n- ')}`);
}

function conceptKey(term) {
  return String(term || '').toLowerCase().replace(/[^a-z0-9+ ]/g, '').replace(/\s+/g, ' ').trim();
}

function visibleCardText(card) {
  return [
    card.lead,
    card.body,
    ...(Array.isArray(card.points) ? card.points : []),
    card.source_quote,
  ].filter(Boolean).join(' ');
}

const FALLBACK_CONCEPTS = {
  topical: {
    level: 'noob',
    text: 'Applied directly to the skin surface rather than swallowed or injected; in this card it clarifies the treatment route being compared.',
  },
};

function visibleForumText(bullet) {
  return [bullet.title, bullet.summary].filter(Boolean).join(' ');
}

function conceptKeys(concepts = {}) {
  return new Set(Object.keys(concepts || {}).map(conceptKey));
}

function hasConceptFor(term, concepts = {}) {
  const wanted = conceptKey(term);
  if (!wanted) return false;
  return conceptKeys(concepts).has(wanted);
}

function repairConceptAliases(summary) {
  const repaired = {
    ...summary,
    sections: (summary.sections || []).map((section) => ({
      ...section,
      cards: (section.cards || []).map((card) => ({
        ...card,
        concepts: { ...(card.concepts || {}) },
      })),
    })),
  };
  let repairCount = 0;

  for (const section of repaired.sections || []) {
    for (const card of section.cards || []) {
      const text = visibleCardText(card);
      const conceptTags = [...text.matchAll(/\{\{concept:([^}]+)\}\}/g)].map((m) => m[1].trim());
      for (const tag of conceptTags) {
        if (hasConceptFor(tag, card.concepts)) continue;
        const wanted = conceptKey(tag);
        const match = Object.entries(card.concepts || {}).find(([term]) => {
          const key = conceptKey(term);
          return key && wanted && (wanted.includes(key) || key.includes(wanted));
        });
        if (match) {
          const [, value] = match;
          card.concepts[tag] = typeof value === 'string' ? value : { ...value };
          repairCount++;
        }
      }
    }
  }

  if (repairCount) info(`anthropic: repaired ${repairCount} concept alias(es)`);
  return repaired;
}

function tagFirstVisibleTerm(value, term) {
  if (typeof value !== 'string') return { value, changed: false };
  if (value.includes(`{{concept:${term}}}`)) return { value, changed: false };
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\b`, 'i');
  if (!re.test(value)) return { value, changed: false };
  return {
    value: value.replace(re, (match) => `{{concept:${match}}}`),
    changed: true,
  };
}

function tagCardTerm(card, term) {
  const body = tagFirstVisibleTerm(card.body, term);
  if (body.changed) return { ...card, body: body.value };

  const points = Array.isArray(card.points) ? [...card.points] : card.points;
  if (!Array.isArray(points)) return card;

  for (let i = 0; i < points.length; i += 1) {
    const point = tagFirstVisibleTerm(points[i], term);
    if (point.changed) {
      points[i] = point.value;
      return { ...card, points };
    }
  }

  return card;
}

function repairRequiredTranslationConcepts(summary, selection) {
  const repaired = {
    ...summary,
    sections: (summary.sections || []).map((section) => ({
      ...section,
      cards: (section.cards || []).map((card) => ({
        ...card,
        concepts: { ...(card.concepts || {}) },
      })),
    })),
  };
  let repairCount = 0;

  for (const section of repaired.sections || []) {
    for (let i = 0; i < (section.cards || []).length; i += 1) {
      let card = section.cards[i];
      const selected = (selection?.selected_items || []).find((item) => selectedItemMatchesCard(item, card));
      if (!selected) continue;

      for (const term of selected.translation_terms || []) {
        if (conceptMapCoversTerm(card.concepts, term)) continue;
        const fallback = FALLBACK_CONCEPTS[conceptKey(term)];
        if (!fallback) continue;
        card.concepts[term] = { ...fallback };
        card = tagCardTerm(card, term);
        repairCount++;
      }
      section.cards[i] = card;
    }
  }

  if (repairCount) info(`anthropic: repaired ${repairCount} required translation concept(s)`);
  return repaired;
}

function termAliases(term) {
  const raw = String(term || '').trim();
  const aliases = new Set([raw]);
  const paren = raw.match(/^(.+?)\s*\((.+?)\)\s*$/);
  if (paren) {
    aliases.add(paren[1].trim());
    aliases.add(paren[2].trim());
  }
  raw.split(/[;/,]| or | and /i)
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => aliases.add(part));
  raw.split(/\s+(?:vs\.?|versus)\s+/i)
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => aliases.add(part));
  aliases.add(raw
    .replace(/\b(administration|treatment|test|protocol|function|compounds?)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim());
  return [...aliases].map(conceptKey).filter(Boolean);
}

function conceptMapCoversTerm(concepts = {}, term) {
  const keys = [...conceptKeys(concepts)];
  const aliases = termAliases(term).filter((alias) => !REDUNDANT_CONCEPTS.has(alias));
  if (!aliases.length) return true;
  if (/\bvs\.?|versus\b/i.test(String(term || ''))) {
    return aliases
      .filter((alias) => alias.length > 2)
      .every((alias) => keys.some((key) => key === alias || key.includes(alias) || alias.includes(key)));
  }
  return aliases.some((alias) => keys.some((key) => key === alias || key.includes(alias) || alias.includes(key)));
}

function validateTranslationTermCoverage(summary, selection) {
  const errors = [];
  for (const section of summary.sections || []) {
    for (const card of section.cards || []) {
      const selected = (selection?.selected_items || []).find((item) => selectedItemMatchesCard(item, card));
      if (!selected) continue;
      const terms = [
        ...(selected.translation_terms || []),
        ...(selected.blog_refs || []).map((ref) => ref.code || `${ref.series || ''}#${ref.number || ''}`),
      ].filter(Boolean);
      for (const term of terms) {
        if (!conceptMapCoversTerm(card.concepts || {}, term)) {
          errors.push(`card "${card.lead}" missing concept explanation for selected term "${term}"`);
        }
      }
    }
  }
  if (errors.length) throw new Error(`translation term coverage failed:\n- ${errors.join('\n- ')}`);
}

function validateConceptIntegrity(summary) {
  const errors = [];

  for (const section of summary.sections || []) {
    for (const card of section.cards || []) {
      const text = visibleCardText(card);
      const conceptTags = [...text.matchAll(/\{\{concept:([^}]+)\}\}/g)].map((m) => m[1].trim());
      for (const tag of conceptTags) {
        if (!hasConceptFor(tag, card.concepts)) {
          errors.push(`card "${card.lead}" uses concept tag "${tag}" without concepts.${tag}`);
        }
      }
    }
  }

  for (const bullet of summary.forum?.bullets || []) {
    const text = visibleForumText(bullet);
    const conceptTags = [...text.matchAll(/\{\{concept:([^}]+)\}\}/g)].map((m) => m[1].trim());
    for (const tag of conceptTags) {
      if (!hasConceptFor(tag, bullet.concepts)) {
        errors.push(`forum bullet "${bullet.title}" uses concept tag "${tag}" without concepts.${tag}`);
      }
    }
  }

  if (errors.length) throw new Error(`concept integrity failed:\n- ${errors.join('\n- ')}`);
}

function stripRedundantConceptTags(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{\{concept:([^}]+)\}\}/g, (match, term) => (
    REDUNDANT_CONCEPTS.has(conceptKey(term)) ? term : match
  ));
}

function normalizeMojibake(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/[\u2013\u2014]/g, ' - ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/\u2192/g, '->')
    .replace(/ג€”|ג€“/g, '-')
    .replace(/ג€˜|ג€™/g, "'")
    .replace(/ג€|ג€/g, '"')
    .replace(/ג€¦/g, '...')
    .replace(/ג†’/g, '->');
}

function sanitizeText(value) {
  if (typeof value !== 'string') return value;
  return stripRedundantConceptTags(normalizeMojibake(value));
}

function sanitizeConceptText(value) {
  if (typeof value !== 'string') return value;
  return sanitizeText(value)
    .replace(/\s*;\s*not standard for [^.]+\.?/gi, '.')
    .replace(/\s*;\s*not the primary choice for [^.]+\.?/gi, '.')
    .replace(/\s*;\s*not proven for [^.]+\.?/gi, '.')
    .replace(/\s*;\s*unsupported for [^.]+\.?/gi, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeConceptMap(concepts = {}) {
  return Object.fromEntries(Object.entries(concepts)
    .filter(([term]) => !REDUNDANT_CONCEPTS.has(conceptKey(term)))
    .map(([term, value]) => {
      if (typeof value === 'string') return [term, sanitizeConceptText(value)];
      if (!value || typeof value !== 'object') return [term, value];
      return [term, { ...value, text: sanitizeConceptText(value.text) }];
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

function selectionForWriting(selection) {
  return {
    ...selection,
    selected_items: (selection.selected_items || []).map((item) => {
      const {
        risk_notes: _riskNotes,
        scientific_translation_plan: _scientificTranslationPlan,
        ...safeItem
      } = item;
      return safeItem;
    }),
  };
}

function extractUrls(text) {
  if (typeof text !== 'string') return [];
  return [...new Set((text.match(/https?:\/\/[^\s)]+/g) || []).map((u) => u.replace(/[.,;]+$/, '')))];
}

function extractPodcastQueue(input) {
  const tweets = input?.twitter?.tweets || [];
  return tweets
    .filter((t) => /podcast|pod\b|episode|interview/i.test(`${t.text || ''} ${t.quoted?.text || ''}`))
    .map((t) => ({
      source_type: 'tweet',
      source_id: t.id,
      tweet_url: `https://x.com/i/status/${t.id}`,
      date_utc: t.date_utc,
      time_utc: t.time_utc,
      urls: extractUrls(`${t.text || ''} ${t.quoted?.text || ''}`),
      text: t.text || '',
      status: 'needs_transcription_extraction',
    }));
}

function isTweetId(id) {
  return typeof id === 'string' && /^\d{10,}$/.test(id);
}

function isPodcastItem(item) {
  return /podcast|pod\b|episode|interview/i.test([
    item.title,
    item.why_interesting,
    item.source_claim,
    item.source_support,
    item.novelty,
    item.writer_brief,
    item.evidence,
  ].filter(Boolean).join(' '));
}

function gateSelection(selection) {
  const minPriority = SETTINGS.aiSelectionMinPriority;
  const selected = selection.selected_items || [];
  const deferredPodcastItems = selected.filter(isPodcastItem);
  const candidates = selected.filter((item) => !isPodcastItem(item));
  const keepItem = (item) => (
    (item.priority || 0) >= minPriority
    || (item.value_type === 'treatment' && item.source_authority === 'jack')
  );
  const strongItems = candidates.filter(keepItem);
  const lowPriorityDrops = candidates
    .filter((item) => !keepItem(item))
    .map((item) => ({
      source_type: item.source_type,
      source_id: item.source_id,
      reason_category: 'below_priority_gate',
      reason: `Selected priority ${item.priority || 0}, below KRUSE_AI_SELECTION_MIN_PRIORITY=${minPriority}.`,
    }));
  const podcastDrops = deferredPodcastItems.map((item) => ({
    source_type: item.source_type,
    source_id: item.source_id,
    reason_category: 'podcast_deferred',
    reason: 'Podcast URL captured in sidecar; transcript/extraction will be handled by a later pipeline.',
  }));

  if (lowPriorityDrops.length) {
    info(`anthropic: curator gate kept ${strongItems.length}/${selected.length} selected item(s); ${lowPriorityDrops.length} low-priority item(s) stay audit-only`);
  }
  if (podcastDrops.length) {
    info(`anthropic: deferred ${podcastDrops.length} podcast item(s) to podcast sidecar`);
  }

  return {
    ...selection,
    selected_items: strongItems,
    dropped_items: [...(selection.dropped_items || selection.unselected_items || []), ...lowPriorityDrops, ...podcastDrops],
    unselected_items: [...(selection.unselected_items || selection.dropped_items || []), ...lowPriorityDrops, ...podcastDrops],
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

// Returns the parsed summary JSON. Also writes it to curated/<date>.json
// unless `dryRun` is true.
export async function summarizeDay(date, { dryRun = false } = {}) {
  const input = loadInput(date);
  const podcastQueue = extractPodcastQueue(input);
  if (podcastQueue.length) writeJsonArtifact(date, 'podcasts', { date, podcasts: podcastQueue });
  const usages = [];

  const curateUser = [
    "Here is the day's 24-hour source JSON. Select only items that meet the curator prompt's acceptance standard.",
    JSON.stringify(input, null, 2),
  ].join('\n\n');
  const curateResult = await callJsonStep(
    date,
    'curate',
    loadPrompt('select-system.md'),
    curateUser,
    validateSelection,
  );
  usages.push(curateResult.usage);
  const selection = attachInputBlogRefs(curateResult.parsed, input);
  validateSelectionCoverage(input, selection);
  writeJsonArtifact(date, 'selection-audit', selection);
  const gatedSelection = gateSelection(selection);
  writeJsonArtifact(date, 'selection-gated', gatedSelection);
  const writerSelection = selectionForWriting(gatedSelection);

  const writeUser = [
    'Original source JSON:',
    JSON.stringify(input, null, 2),
    '',
    'Curated selected items:',
    JSON.stringify(writerSelection, null, 2),
  ].join('\n');
  const writeResult = await callJsonStep(
    date,
    'write',
    loadPrompt('write-system.md'),
    writeUser,
    validateSummary,
  );
  usages.push(writeResult.usage);
  writeJsonArtifact(date, 'draft', writeResult.parsed);

  const explainUser = [
    'Original source JSON:',
    JSON.stringify(input, null, 2),
    '',
    'Curated selected items:',
    JSON.stringify(writerSelection, null, 2),
    '',
    'Draft renderer JSON:',
    JSON.stringify(writeResult.parsed, null, 2),
  ].join('\n');
  const explainResult = await callJsonStep(
    date,
    'explain',
    loadPrompt('explain-system.md'),
    explainUser,
    validateSummary,
  );
  usages.push(explainResult.usage);
  validateExplanationPreservesDraft(writeResult.parsed, explainResult.parsed);
  writeJsonArtifact(date, 'explained', explainResult.parsed);

  const repairedSummary = repairSummarySourceQuotes(explainResult.parsed, input, gatedSelection);
  const summary = repairRequiredTranslationConcepts(
    repairConceptAliases(sanitizeSummary(repairedSummary)),
    gatedSelection
  );
  validateSummary(summary);
  validateReportVoice(summary);
  validateNoQuestionFraming(summary);
  validateSummaryProvenance(summary, input, podcastQueue, gatedSelection);
  validateTranslationTermCoverage(summary, gatedSelection);
  validateConceptIntegrity(summary);
  validatePrivatePhraseExplanations(summary);
  writeJsonArtifact(date, 'verification', {
    date,
    status: 'passed',
    checks: [
      'schema',
      'selection_coverage',
      'blog_ref_enrichment',
      'source_group_section_titles',
      'forum_bullets_empty',
      'science_explanation_preserved_source_fields',
      'report_voice_no_ai_opinion_or_absence_language',
      'no_question_or_watchlist_framing',
      'source_id_membership',
      'forum_thread_membership',
      'source_quote_membership',
      'source_quote_repair_from_curator_quotes',
      'podcast_deferral',
      'citation_source_citations_membership',
      'pseudo_citation_guard',
      'concept_alias_repair',
      'translation_term_coverage',
      'concept_integrity',
      'private_phrase_explanation',
    ],
  });

  info(`anthropic: usage totals - ${formatUsageTotals(usages)}`);

  if (!dryRun) {
    const outPath = path.join(ROOT, 'curated', `${date}.json`);
    writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');
    info(`anthropic: wrote ${path.relative(ROOT, outPath)}`);
  }
  return summary;
}
