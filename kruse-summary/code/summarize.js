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
const BLOG_SERIES_NAMES = {
  BTC: 'BTC',
  CPC: 'CPC',
  DM: 'Decentralized Medicine',
  HYPOXIA: 'Hypoxia',
  QT: 'QT',
};
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

export function shouldUseAnthropicStreaming(maxTokens) {
  return Number(maxTokens || 0) >= 20000;
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

function cleanOneLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
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

function classificationKeys(selection) {
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
  return seen;
}

function omittedSelectionItem(input, key) {
  const [type, id] = key.split(':');
  const base = {
    source_type: type,
    reason_category: 'model_omitted',
    reason: 'Curator omitted this source from the audit lists; keeping it audit-only rather than selecting it.',
  };
  if (type === 'tweet') {
    const tweet = (input?.twitter?.tweets || []).find((t) => String(t.id) === id);
    return {
      ...base,
      source_id: id,
      title: cleanOneLine(tweet?.text || `Tweet ${id}`).slice(0, 120),
    };
  }
  if (type === 'forum') {
    const post = (input?.forum?.posts || []).find((p) => forumSelectionId(p.thread_url) === id);
    return {
      ...base,
      source_id: post?.thread_url || id,
      source_url: post?.thread_url || undefined,
      source_authority: String(post?.author || '').toLowerCase().includes('jack') ? 'jack' : 'member',
      title: post?.thread_title || `Forum thread ${id}`,
    };
  }
  return { ...base, source_id: id };
}

export function repairSelectionCoverage(input, selection) {
  const secondaryKey = Array.isArray(selection.unselected_items) ? 'unselected_items' : 'dropped_items';
  const seenKeys = new Set();
  let duplicateRepairCount = 0;
  const keepUnique = (items = []) => items.filter((item) => {
    const key = selectionKey(item);
    if (!key || /^(tweet|forum):$/.test(key)) return true;
    if (seenKeys.has(key)) {
      duplicateRepairCount++;
      return false;
    }
    seenKeys.add(key);
    return true;
  });
  let repaired = {
    ...selection,
    selected_items: keepUnique(selection.selected_items || []),
    [secondaryKey]: keepUnique(selection[secondaryKey] || []),
  };
  if (duplicateRepairCount) {
    info(`anthropic: removed ${duplicateRepairCount} duplicate source classification(s) from audit`);
  }

  const expected = inputSourceKeys(input);
  const seen = classificationKeys(repaired);
  const missing = [...expected].filter((key) => !seen.has(key));
  if (!missing.length) return repaired;
  const repairs = missing.map((key) => omittedSelectionItem(input, key));
  info(`anthropic: repaired ${repairs.length} omitted source classification(s) as audit-only`);
  if (secondaryKey === 'unselected_items') {
    return { ...repaired, unselected_items: [...(repaired.unselected_items || []), ...repairs] };
  }
  return { ...repaired, dropped_items: [...(repaired.dropped_items || []), ...repairs] };
}

function validateSelectionCoverage(input, selection) {
  const expected = inputSourceKeys(input);
  const seen = classificationKeys(selection);

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

function citationText(citation) {
  return `${citation?.paper || ''} ${citation?.claim || ''}`.trim();
}

export function hasVerifiableCitation(citation) {
  const paper = String(citation?.paper || '').trim();
  if (!paper) return false;
  if (/\b(or its close equivalents|referenced in quoted|quoted tweet|quoted source|source tweet)\b/i.test(paper)) {
    return false;
  }

  const hasPersistentId = /\b(?:doi|pmid|pmcid|arxiv|nct)\s*[:#]?\s*[a-z0-9./-]+/i.test(paper);
  const hasYear = /\b(?:19|20)\d{2}\b/.test(paper);
  const hasAuthor = /\b[A-Z][A-Za-z'’-]{2,}\s+(?:et al\.?|and\s+[A-Z][A-Za-z'’-]{2,}|[A-Z]\.)\b/.test(paper)
    || /\b[A-Z][A-Za-z'’-]{2,},\s*(?:[A-Z][A-Za-z'’-]{2,},\s*)?(?:and\s+)?[A-Z][A-Za-z'’-]{2,}\b/.test(paper);
  const hasVenue = /\b(?:journal|proceedings|transactions|nature|science|cell|lancet|jama|nejm|pnas|bmj|frontiers|clinical bioenergetics|bioenergetics|metabolism|oncology|cancer|mitochondri)\b/i.test(paper);
  const hasSpecificTitle = /["“”].{12,}["“”]/.test(paper)
    || /[A-Z][^.!?]{18,}:\s*[^.!?]{8,}/.test(paper);

  if (hasPersistentId) return true;
  if (/^\s*(?:a\s+)?(?:new\s+|recent\s+)?(?:narrative\s+)?review\s+in\b/i.test(paper)
    && !hasYear && !hasAuthor && !hasSpecificTitle) {
    return false;
  }

  const anchors = [hasYear, hasAuthor, hasVenue, hasSpecificTitle].filter(Boolean).length;
  return anchors >= 2;
}

function filterVerifiableCitations(citations = []) {
  return (Array.isArray(citations) ? citations : []).filter(hasVerifiableCitation);
}

export function repairSelectionCitations(selection) {
  let removed = 0;
  const repaired = {
    ...selection,
    selected_items: (selection?.selected_items || []).map((item) => {
      const before = item.source_citations || [];
      const source_citations = filterVerifiableCitations(before);
      removed += before.length - source_citations.length;
      return { ...item, source_citations };
    }),
  };
  if (removed) info(`anthropic: removed ${removed} weak formal citation(s) without author/journal/year anchors`);
  return repaired;
}

export function repairSummaryCitations(summary) {
  let removed = 0;
  const repaired = {
    ...summary,
    sections: (summary.sections || []).map((section) => ({
      ...section,
      cards: (section.cards || []).map((card) => {
        const before = card.citations || [];
        const citations = filterVerifiableCitations(before);
        removed += before.length - citations.length;
        return { ...card, citations };
      }),
    })),
  };
  if (removed) info(`anthropic: removed ${removed} weak rendered citation(s) without author/journal/year anchors`);
  return repaired;
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
          const text = citationText(citation);
          if (/Kruse tweet|podcast pointer|Podcast linked|\bCPC\s*#?\d+|forum thread|blog post|source link|podcast title/i.test(text)) {
            errors.push(`card "${card.lead}" has pseudo-citation: ${citation.paper}`);
          }
          if (!hasVerifiableCitation(citation)) {
            errors.push(`card "${card.lead}" has weak formal citation without author/journal/year anchors: ${citation.paper}`);
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

function sectionSourceType(sectionTitle) {
  if (/twitter/i.test(String(sectionTitle || ''))) return 'tweet';
  if (/forum/i.test(String(sectionTitle || ''))) return 'forum';
  return '';
}

function selectedItemSourceValue(item) {
  if (item?.source_type === 'tweet') return String(item.source_id || '');
  if (item?.source_type === 'forum') return String(item.source_url || item.source_id || '');
  return '';
}

function cardHasExpectedSource(card, sourceType) {
  if (sourceType === 'tweet') return Array.isArray(card.source_ids) && card.source_ids.length;
  if (sourceType === 'forum') return Array.isArray(card.source_urls) && card.source_urls.some(isForumUrl);
  return true;
}

function selectedItemSupportText(item) {
  return normalizeSupportText([
    item?.title,
    item?.why_interesting,
    item?.source_claim,
    item?.mechanism,
    item?.reader_change,
    item?.source_support,
    ...(item?.support_quotes || []),
  ].filter(Boolean).join(' '));
}

function cardMatchScore(card, item) {
  const quote = normalizeSupportText(card?.source_quote);
  const itemText = selectedItemSupportText(item);
  if (quote && itemText.includes(quote)) return 1000;

  const cardText = normalizeCitation([
    card?.lead,
    card?.body,
    ...(Array.isArray(card?.points) ? card.points : []),
  ].filter(Boolean).join(' '));
  const sourceText = normalizeCitation(selectedItemSupportText(item));
  const tokens = [...new Set(cardText.split(' ').filter((token) => token.length >= 5))];
  if (!tokens.length || !sourceText) return 0;
  const hits = tokens.filter((token) => sourceText.includes(token)).length;
  return hits / tokens.length;
}

function applySelectedItemSource(card, item) {
  if (item.source_type === 'tweet') {
    return {
      ...card,
      source_ids: [String(item.source_id)],
      source_urls: Array.isArray(card.source_urls) ? card.source_urls : [],
    };
  }
  if (item.source_type === 'forum') {
    return {
      ...card,
      source_ids: Array.isArray(card.source_ids) ? card.source_ids : [],
      source_urls: [selectedItemSourceValue(item)],
    };
  }
  return card;
}

export function repairSummaryCardSources(summary, selection, { logRepairs = true } = {}) {
  let repairCount = 0;
  const selectedByType = new Map([
    ['tweet', (selection?.selected_items || []).filter((item) => item.source_type === 'tweet')],
    ['forum', (selection?.selected_items || []).filter((item) => item.source_type === 'forum')],
  ]);
  const used = new Set();

  const repaired = {
    ...summary,
    sections: (summary.sections || []).map((section) => ({
      ...section,
      cards: (section.cards || []).map((card) => ({ ...card })),
    })),
  };

  for (const section of repaired.sections || []) {
    const sourceType = sectionSourceType(section.title);
    if (!sourceType) continue;
    for (let i = 0; i < (section.cards || []).length; i += 1) {
      let card = section.cards[i];
      if (cardHasExpectedSource(card, sourceType)) {
        for (const value of sourceType === 'tweet' ? (card.source_ids || []) : (card.source_urls || [])) {
          used.add(`${sourceType}:${String(value)}`);
        }
        continue;
      }

      const candidates = (selectedByType.get(sourceType) || [])
        .filter((item) => {
          const value = selectedItemSourceValue(item);
          return value && !used.has(`${sourceType}:${value}`);
        })
        .map((item) => ({ item, score: cardMatchScore(card, item) }))
        .sort((a, b) => b.score - a.score);
      const match = candidates.find((candidate) => candidate.score >= 0.12) || candidates[0];
      if (!match?.item) continue;

      card = applySelectedItemSource(card, match.item);
      section.cards[i] = card;
      used.add(`${sourceType}:${selectedItemSourceValue(match.item)}`);
      repairCount += 1;
    }
  }

  if (repairCount && logRepairs) info(`anthropic: repaired ${repairCount} missing card source reference(s) from curator selection`);
  return repaired;
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

export function dropPodcastDeferredCards(summary, podcastQueue = []) {
  const podcastIds = new Set(podcastQueue.map((p) => String(p.source_id)));
  if (!podcastIds.size) return summary;
  let dropCount = 0;
  const repaired = {
    ...summary,
    sections: (summary.sections || []).map((section) => {
      const cards = (section.cards || []).filter((card) => {
        const usesDeferredPodcast = (card.source_ids || []).some((id) => podcastIds.has(String(id)));
        if (usesDeferredPodcast) dropCount++;
        return !usesDeferredPodcast;
      });
      return { ...section, cards };
    }),
  };
  if (dropCount) info(`anthropic: dropped ${dropCount} podcast-deferred card(s) from report body`);
  return repaired;
}

const REPORT_VOICE_BANNED = /\b(my read|wrong|right|uncited|no citation|without citation|not proven|unsupported|speculative|fake|AI BS|Codex|Anthropic|without mechanism|no mechanism|without trial|no trial|does not provide mechanism|does not provide dosing|mechanism or dosing detail|not standard|standard of care|efficacy or safety advantage|stronger evidence base|trial data (?:was )?not provided|not provided in (?:the )?source|likely refers|possibly|may refer|important for cellular health)\b/i;

function stripReportVoiceSentence(text) {
  const value = String(text || '').trim();
  if (!value || !REPORT_VOICE_BANNED.test(value)) return text;
  const sentences = value.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((sentence) => !REPORT_VOICE_BANNED.test(sentence));
  if (kept.length && kept.length !== sentences.length) return kept.join(' ').trim();
  if (/^(?:the )?source (?:does not|doesn't) provide\b/i.test(value)) return '';
  if (/^(?:no|without) (?:mechanism|trial|citation)\b/i.test(value)) return '';
  const fallback = value
    .replace(/\bthe source does not provide (?:mechanism|dosing|trial data|mechanism or dosing detail)[^.!?;]*/gi, '')
    .replace(/\bdoes not provide (?:mechanism|dosing|trial data|mechanism or dosing detail)[^.!?;]*/gi, '')
    .replace(/\btrial data (?:was )?not provided\b/gi, '')
    .replace(/\bnot provided in (?:the )?source\b/gi, '')
    .replace(/\b(?:without|no) (?:mechanism|trial|citation)\b/gi, '')
    .replace(/\b(?:uncited|not proven|unsupported|speculative|fake|not standard|standard of care)\b/gi, '')
    .replace(/\b(?:likely|possibly|may) refer(?:s)?(?: to)?\b/gi, 'refers to')
    .replace(/\bimportant for cellular health\b/gi, 'relevant to the mechanism')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
  return fallback && !REPORT_VOICE_BANNED.test(fallback) ? fallback : '';
}

export function repairReportVoice(summary) {
  let repairCount = 0;
  const repaired = {
    ...summary,
    sections: (summary.sections || []).map((section) => ({
      ...section,
      cards: (section.cards || []).map((card) => {
        const next = { ...card };
        for (const field of ['lead', 'body']) {
          const repairedText = stripReportVoiceSentence(next[field]);
          if (repairedText !== next[field]) {
            if (repairedText) {
              next[field] = repairedText;
            } else if (field === 'body') {
              next[field] = (next.points || []).find((point) => !REPORT_VOICE_BANNED.test(String(point || '')))
                || next.source_quote
                || next[field];
            }
            repairCount++;
          }
        }
        if (Array.isArray(next.points)) {
          const points = [];
          for (const point of next.points) {
            const repairedPoint = stripReportVoiceSentence(point);
            if (repairedPoint) points.push(repairedPoint);
            if (repairedPoint !== point) repairCount++;
          }
          next.points = points.length ? points : next.points;
        }
        if (next.concepts && typeof next.concepts === 'object') {
          next.concepts = Object.fromEntries(Object.entries(next.concepts).map(([term, value]) => {
            if (typeof value === 'string') {
              const repairedText = stripReportVoiceSentence(value);
              if (repairedText !== value) repairCount++;
              return [term, repairedText || value];
            }
            if (value && typeof value === 'object' && typeof value.text === 'string') {
              const repairedText = stripReportVoiceSentence(value.text);
              if (repairedText !== value.text) repairCount++;
              return [term, { ...value, text: repairedText || value.text }];
            }
            return [term, value];
          }));
        }
        return next;
      }),
    })),
  };
  if (repairCount) info(`anthropic: repaired ${repairCount} banned report voice sentence(s)`);
  return repaired;
}

export function validateReportVoice(summary) {
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
    .filter(([, text]) => REPORT_VOICE_BANNED.test(String(text || '')))
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

function normalizeBlogRefCode(value) {
  const match = String(value || '').match(/\b([A-Z][A-Z0-9]{1,16})\s*#\s*(\d{1,4})\b/i);
  if (!match) return '';
  return `${match[1].toUpperCase()}#${match[2]}`;
}

function blogRefCode(ref) {
  if (!ref) return '';
  return normalizeBlogRefCode(ref.code || `${ref.series || ''}#${ref.number || ''}`);
}

function blogRefConcept(refOrTerm) {
  const code = typeof refOrTerm === 'string' ? normalizeBlogRefCode(refOrTerm) : blogRefCode(refOrTerm);
  if (!code) return null;
  const [, series, number] = code.match(/^([A-Z0-9]+)#(\d+)$/) || [];
  const seriesName = BLOG_SERIES_NAMES[series] || series;
  const title = typeof refOrTerm === 'object' && refOrTerm?.title ? ` Title: ${refOrTerm.title}.` : '';
  return {
    level: 'noob',
    text: `${code} is a Kruse blog/article archive reference from the ${seriesName} series, entry #${number}.${title} It is source context for this report, not a formal scientific citation.`,
  };
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
  'internal water table': {
    level: 'noob',
    text: 'Kruse shorthand for structured water and charge storage inside tissues; the practical claim is that tissue hydration/electrical order changes how well cells hold and move charge.',
  },
  'internal water table collapse': {
    level: 'noob',
    text: 'Kruse shorthand for a loss of structured tissue water and charge storage; translated plainly, the claim is that tissue water becomes less organized and holds/moves electrical charge less effectively.',
  },
  'water table collapse': {
    level: 'noob',
    text: 'Short form of internal water table collapse: a claimed loss of organized tissue water and charge-storage behavior, not a literal groundwater table inside the body.',
  },
  'eds ehlersdanlos syndrome': {
    level: 'noob',
    text: 'A group of connective-tissue disorders marked by loose or fragile collagen, often showing up as hypermobile joints, easy injury, pain, or vascular/skin fragility.',
  },
  groundinguninsulated: {
    level: 'noob',
    text: 'Grounding means giving the body a conductive path to the earth; uninsulated means the body is not electrically isolated, so excess charge can dissipate instead of remaining trapped.',
  },
  groundingungrounded: {
    level: 'noob',
    text: 'Grounded tissue has a conductive path to the earth; ungrounded tissue lacks that discharge route, so Kruse frames it as more likely to retain excess charge.',
  },
  insulationgrounding: {
    level: 'noob',
    text: 'Insulation blocks charge movement; grounding provides a conductive path for charge to dissipate. Kruse uses the contrast to describe whether tissue can unload excess charge.',
  },
  insulation: {
    level: 'noob',
    text: 'Electrical insulation means resistance to charge movement. In this report it refers to whether tissue holds charge locally instead of letting it leak away.',
  },
  uninsulatedungrounded: {
    level: 'noob',
    text: 'Uninsulated/ungrounded means there is no easy conductive path for charge to leave the body, so Kruse frames the tissue as electrically isolated and more charge-retentive.',
  },
  'charge accumulation': {
    level: 'noob',
    text: 'A buildup of electrical charge in tissue or an environment; in these reports it matters because Kruse links charge separation and discharge paths to signaling and tissue behavior.',
  },
  'positive charge accumulation': {
    level: 'noob',
    text: 'A buildup of net positive electrical charge in tissue; in Kruse language this points to poorer electron availability and weaker tissue charge separation.',
  },
  'internal batterycapacitance': {
    level: 'noob',
    text: 'A capacitance analogy: tissues are treated like charge-storing surfaces, so changes in water, collagen, minerals, and grounding can alter how much electrical potential the body can hold.',
  },
  'internal battery': {
    level: 'noob',
    text: 'Kruse shorthand for the body\'s ability to separate, store, and move electrical charge across water, collagen, membranes, and mitochondria.',
  },
  capacitance: {
    level: 'noob',
    text: 'The ability of a material or system to store electrical charge. In body-language analogies, higher capacitance means tissue can hold more separated charge.',
  },
  'john ellis machine': {
    level: 'noob',
    text: 'A water-processing device associated with deuterium-depleted water claims; the report only treats Kruse\'s claim about that machine, not an independent endorsement.',
  },
  'deuterium depletion': {
    level: 'noob',
    text: 'Lowering the amount of deuterium, the heavy isotope of hydrogen, in water or the body. Kruse links lower deuterium load to mitochondrial and water-chemistry effects.',
  },
  deuterium: {
    level: 'noob',
    text: 'A heavier form of hydrogen. Kruse uses deuterium load as a water-chemistry and mitochondrial-efficiency variable, especially when discussing deuterium-depleted water or proton flow.',
  },
  'deuterium d+': {
    level: 'noob',
    text: 'Deuterium is heavy hydrogen; D+ means its positively charged ion form. In this report it matters because Kruse links heavier hydrogen handling to mitochondrial water and energy chemistry.',
  },
  'protium 1h': {
    level: 'noob',
    text: 'Protium is ordinary light hydrogen, the common 1H isotope. Kruse contrasts it with deuterium because lighter hydrogen moves differently in water and mitochondrial proton chemistry.',
  },
  'deuterium concentration ppm': {
    level: 'noob',
    text: 'The amount of deuterium measured in parts per million. Normal water is often around 150 ppm; deuterium-depleted water claims usually refer to lowering that number.',
  },
  'infrared 066 ev pulse': {
    level: 'pro',
    text: 'Infrared light is heat-range light. A 0.66 eV photon is near-infrared energy; Kruse uses this range when discussing light-driven water, mitochondrial, or exclusion-zone effects.',
  },
  infrared: {
    level: 'noob',
    text: 'Light just beyond visible red. In biology discussions it usually points to heat, mitochondrial signaling, and water-structure effects rather than vitamin-D production.',
  },
  'reduced mass': {
    level: 'pro',
    text: 'A physics term for how two bonded particles behave as one vibrating system. Replacing protium with heavier deuterium changes reduced mass and therefore bond vibration behavior.',
  },
  'singlet oxygen': {
    level: 'pro',
    text: 'A high-energy excited form of oxygen. It is more reactive than normal oxygen and is often discussed in light, redox, and oxidative-signaling contexts.',
  },
  'triplet oxygen': {
    level: 'pro',
    text: 'The normal ground-state form of molecular oxygen. It has unpaired electron spin, which is why oxygen chemistry often connects to magnetism, spin state, and redox reactions.',
  },
  'collagen crosslinking': {
    level: 'noob',
    text: 'Chemical bonding between collagen fibers that changes tissue stiffness and strength. Too much or abnormal cross-linking can make tissue less flexible or less repairable.',
  },
  'lower esophageal sphincter les': {
    level: 'noob',
    text: 'The muscle valve between the esophagus and stomach. If it does not close well, stomach contents can reflux upward and drive GERD symptoms.',
  },
  'lower esophageal sphincter': {
    level: 'noob',
    text: 'The muscle valve at the bottom of the esophagus that keeps stomach contents from flowing backward.',
  },
  'spincoherence': {
    level: 'pro',
    text: 'A quantum/physics phrase for coordinated spin behavior. In Kruse language it usually points to whether electron/proton/magnetic states remain organized enough to support signaling.',
  },
  'spin coherence': {
    level: 'pro',
    text: 'Coordinated spin behavior in particles such as electrons or protons; Kruse uses it as part of his magnetic and mitochondrial signaling language.',
  },
  'geomagnetic reference frame': {
    level: 'noob',
    text: 'The earth\'s magnetic-field context at a location. Kruse uses it as a baseline environmental signal that biological electrical and magnetic behavior may align to.',
  },
  'fluid dynamics': {
    level: 'noob',
    text: 'The physics of how liquids and gases move, including flow, pressure, turbulence, and mixing. In water-system cards it explains movement rather than static chemistry alone.',
  },
  permittivity: {
    level: 'pro',
    text: 'A material property describing how well a medium stores electrical energy in an electric field. Water, minerals, and tissues differ in permittivity, which affects charge behavior.',
  },
  nnemf: {
    level: 'noob',
    text: 'Non-native electromagnetic fields: man-made electrical, wireless, or magnetic exposures. Kruse uses the term when arguing that artificial fields can disturb charge, water structure, or mitochondrial signaling.',
  },
  'nnemf nonnative electromagnetic field': {
    level: 'noob',
    text: 'Non-native electromagnetic field: artificial EMF from modern electrical or wireless systems, contrasted with natural light, geomagnetic, and atmospheric fields.',
  },
  'non native electromagnetic field': {
    level: 'noob',
    text: 'Artificial electromagnetic exposure from technology rather than natural solar, atmospheric, or geomagnetic sources.',
  },
  'dielectric collapse': {
    level: 'noob',
    text: 'A dielectric is an insulating material that can store electrical energy in an electric field. Dielectric collapse means Kruse is claiming the tissue/water system loses that charge-storage behavior.',
  },
  'gastroesophageal reflux disease gerd': {
    level: 'noob',
    text: 'GERD is chronic acid reflux: stomach contents repeatedly move upward into the esophagus, causing burning, irritation, cough, or throat symptoms.',
  },
  gerd: {
    level: 'noob',
    text: 'Gastroesophageal reflux disease: chronic reflux where stomach contents move upward into the esophagus and irritate it.',
  },
  'hiatal hernia': {
    level: 'noob',
    text: 'A condition where part of the stomach pushes up through the diaphragm opening. It can worsen reflux by weakening the normal barrier between stomach and esophagus.',
  },
  hypothyroidism: {
    level: 'noob',
    text: 'Low thyroid hormone output or effect. Common consequences include fatigue, cold intolerance, constipation, weight gain, dry skin, and slower metabolism.',
  },
  'vagal tone': {
    level: 'noob',
    text: 'How strongly the vagus nerve supports rest-and-digest functions such as digestion, heart-rate regulation, inflammation control, and gut motility.',
  },
  'isotopic purification': {
    level: 'pro',
    text: 'A chemistry phrase for shifting isotope mix. In Kruse context this usually means reducing heavy hydrogen/deuterium burden so water and mitochondrial proton handling are more favorable.',
  },
  'grounding capacity': {
    level: 'noob',
    text: 'How well the body or tissue can discharge electrical charge through a conductive connection to earth or another reference path.',
  },
  hypermobility: {
    level: 'noob',
    text: 'Joints moving beyond the usual range, often because connective tissue is unusually loose or elastic.',
  },
  'porous rock': {
    level: 'noob',
    text: 'Rock with connected holes or channels that let water move through it; limestone aquifers matter because water flow, minerals, and charge can interact across a large underground surface area.',
  },
  porosity: {
    level: 'noob',
    text: 'How much connected empty space exists inside a material such as limestone; higher porosity lets water, minerals, and ions move through the rock.',
  },
  'underground rivers': {
    level: 'noob',
    text: 'Subsurface water channels that move through caves or porous rock instead of visible surface riverbeds.',
  },
  'underground hydrology': {
    level: 'noob',
    text: 'The study of how water moves and stores underground, including aquifers, caves, flow paths, pressure, minerals, and mixing with seawater.',
  },
  'underground aquifer': {
    level: 'noob',
    text: 'A body of water stored and moving below ground through porous rock or cave systems.',
  },
  'subsurface hydrology': {
    level: 'noob',
    text: 'How water behaves below the surface: where it is stored, how it flows, and how it mixes with minerals or seawater.',
  },
  'underground water table': {
    level: 'noob',
    text: 'The level and connected body of water held below ground; in Yucatan this is shaped by porous limestone, caves, cenotes, and seawater mixing.',
  },
  'subsurface currents': {
    level: 'noob',
    text: 'Hidden water flows below the ground surface, often moving through cave channels or porous rock.',
  },
  'ocean infiltration': {
    level: 'noob',
    text: 'Seawater entering underground freshwater systems through porous coastal rock; that can change minerals, salinity, electrical conductivity, and the local water environment.',
  },
  'mineral infiltration': {
    level: 'noob',
    text: 'Minerals moving into water or tissue from the surrounding material; in an aquifer this changes conductivity, pH, salinity, and the chemistry of the water environment.',
  },
  'geological infiltration': {
    level: 'noob',
    text: 'Water or dissolved minerals moving through geological layers such as limestone, caves, and porous rock.',
  },
  'water infiltration': {
    level: 'noob',
    text: 'Water entering and moving through soil, rock, caves, or tissue spaces rather than staying on the surface.',
  },
  'subsurface systems': {
    level: 'noob',
    text: 'Underground networks such as aquifers, caves, porous rock, mineral beds, and hidden water channels.',
  },
  'yucatn peninsula': {
    level: 'noob',
    text: 'The Yucatan Peninsula is a limestone-rich region in southeastern Mexico with extensive cenotes, caves, and underground water systems.',
  },
  'yucatan peninsula': {
    level: 'noob',
    text: 'The Yucatan Peninsula is a limestone-rich region in southeastern Mexico with extensive cenotes, caves, and underground water systems.',
  },
  'maya sacred sites': {
    level: 'noob',
    text: 'Ceremonial or culturally important Maya locations, often tied to cenotes and caves in this source because those places sit on unusual water and limestone geology.',
  },
  maya: {
    level: 'noob',
    text: 'The Indigenous Mesoamerican civilization associated with the Yucatan region; the source links Maya sacred places to cenotes and underground water systems.',
  },
  geophysical: {
    level: 'noob',
    text: 'Physical features and forces of the earth, such as geology, water movement, minerals, magnetism, electric fields, and light conditions.',
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

export function repairConceptAliases(summary) {
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
          continue;
        }
        card.concepts[tag] = { ...fallbackConceptForTerm(tag) };
        repairCount++;
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

export function repairRequiredTranslationConcepts(summary, selection) {
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

      const requiredConcepts = [
        ...(selected.translation_terms || []).map((term) => ({
          term,
          fallback: fallbackConceptForTerm(term),
        })),
        ...(selected.blog_refs || []).map((ref) => {
          const term = blogRefCode(ref);
          return {
            term,
            fallback: blogRefConcept(ref),
          };
        }),
      ].filter((item) => item.term && item.fallback);

      for (const { term, fallback } of requiredConcepts) {
        if (conceptMapCoversTerm(card.concepts, term)) continue;
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

const JACK_FORUM_PRIORITY_THREE_TYPES = new Set([
  'case',
  'geo',
  'geology',
  'mechanism',
  'protocol',
  'research',
  'treatment',
]);

function isJackForumPriorityThreeSignal(item) {
  return item.source_type === 'forum'
    && item.source_authority === 'jack'
    && (item.priority || 0) >= 3
    && JACK_FORUM_PRIORITY_THREE_TYPES.has(String(item.value_type || '').toLowerCase());
}

function fallbackConceptForTerm(term) {
  const key = conceptKey(term);
  const blogConcept = blogRefConcept(term);
  if (blogConcept) return blogConcept;
  if (FALLBACK_CONCEPTS[key]) return FALLBACK_CONCEPTS[key];

  for (const alias of termAliases(term)) {
    if (FALLBACK_CONCEPTS[alias]) return FALLBACK_CONCEPTS[alias];
  }

  if (key.includes('deuterium')) return FALLBACK_CONCEPTS.deuterium;
  if (key.includes('nnemf') || key.includes('electromagnetic field')) return FALLBACK_CONCEPTS.nnemf;
  if (key.includes('dielectric')) return FALLBACK_CONCEPTS['dielectric collapse'];
  if (key.includes('gastroesophageal') || key.includes('gerd')) return FALLBACK_CONCEPTS.gerd;
  if (key.includes('hiatal hernia')) return FALLBACK_CONCEPTS['hiatal hernia'];
  if (key.includes('hypothyroid')) return FALLBACK_CONCEPTS.hypothyroidism;
  if (key.includes('vagal')) return FALLBACK_CONCEPTS['vagal tone'];
  if (key.includes('isotopic')) return FALLBACK_CONCEPTS['isotopic purification'];
  if (key.includes('protium')) return FALLBACK_CONCEPTS['protium 1h'];
  if (key.includes('infrared')) return FALLBACK_CONCEPTS.infrared;
  if (key.includes('reduced mass')) return FALLBACK_CONCEPTS['reduced mass'];
  if (key.includes('singlet oxygen')) return FALLBACK_CONCEPTS['singlet oxygen'];
  if (key.includes('triplet oxygen')) return FALLBACK_CONCEPTS['triplet oxygen'];
  if (key.includes('collagen') && key.includes('cross')) return FALLBACK_CONCEPTS['collagen crosslinking'];
  if (key.includes('esophageal sphincter') || key === 'les') return FALLBACK_CONCEPTS['lower esophageal sphincter'];
  if (key.includes('spin')) return FALLBACK_CONCEPTS['spin coherence'];
  if (key.includes('geomagnetic')) return FALLBACK_CONCEPTS['geomagnetic reference frame'];
  if (key.includes('fluid dynamics')) return FALLBACK_CONCEPTS['fluid dynamics'];
  if (key.includes('permittivity')) return FALLBACK_CONCEPTS.permittivity;

  return {
    level: 'noob',
    text: `A technical term used by the selected source. The report keeps "${String(term || '').trim()}" visible as source language; treat it as a term to verify in the linked source before turning it into a protocol.`,
  };
}

export function repairPrivatePhraseConcepts(summary) {
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
      const visible = conceptKey([
        card.lead,
        card.body,
        ...(Array.isArray(card.points) ? card.points : []),
      ].filter(Boolean).join(' '));
      for (const phrase of KRUSE_PRIVATE_PHRASES) {
        const key = conceptKey(phrase);
        if (!key || !visible.includes(key)) continue;
        if (conceptMapCoversTerm(card.concepts, phrase)) continue;
        const fallback = FALLBACK_CONCEPTS[key];
        if (!fallback) continue;
        card.concepts[phrase] = { ...fallback };
        card = tagCardTerm(card, phrase);
        repairCount++;
      }
      section.cards[i] = card;
    }
  }

  if (repairCount) info(`anthropic: repaired ${repairCount} private phrase concept(s)`);
  return repaired;
}

export function gateSelection(selection) {
  const minPriority = SETTINGS.aiSelectionMinPriority;
  const selected = selection.selected_items || [];
  const deferredPodcastItems = selected.filter(isPodcastItem);
  const candidates = selected.filter((item) => !isPodcastItem(item));
  const keepItem = (item) => (
    (item.priority || 0) >= minPriority
    || (item.value_type === 'treatment' && item.source_authority === 'jack')
    || isJackForumPriorityThreeSignal(item)
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableAnthropicError(err) {
  const status = err?.status || err?.code || err?.error?.status;
  if ([408, 409, 429, 500, 502, 503, 504, 529].includes(Number(status))) return true;
  return /overload|overloaded|rate.?limit|temporar|timeout|timed out|ECONNRESET|ETIMEDOUT/i.test(String(err?.message || ''));
}

async function createAnthropicMessage(label, payload) {
  const maxAttempts = Math.max(1, SETTINGS.anthropicMaxRetries + 1);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (shouldUseAnthropicStreaming(payload.max_tokens)) {
        info(`anthropic:${label}: streaming response enabled for long output budget`);
        return await client().messages.stream(payload).finalMessage();
      }
      return await client().messages.create(payload);
    } catch (err) {
      if (attempt >= maxAttempts || !isRetriableAnthropicError(err)) throw err;
      const delayMs = SETTINGS.anthropicRetryBaseMs * (2 ** (attempt - 1));
      warn(`anthropic:${label}: transient API failure on attempt ${attempt}/${maxAttempts} (${err.status || err.message}); retrying in ${Math.round(delayMs / 1000)}s`);
      await sleep(delayMs);
    }
  }
  throw new Error(`anthropic:${label}: exhausted retries`);
}

async function callJsonStep(date, label, systemPrompt, userMessage, validator) {
  info(`anthropic:${label}: calling ${SETTINGS.anthropicModel} (max_tokens=${SETTINGS.anthropicMaxTokens})`);
  info(`anthropic:${label}: input ${(userMessage.length / 1024).toFixed(1)} KB, system ${(systemPrompt.length / 1024).toFixed(1)} KB`);

  const response = await createAnthropicMessage(label, {
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
  const selection = repairSelectionCitations(repairSelectionCoverage(input, attachInputBlogRefs(curateResult.parsed, input)));
  validateSelectionCoverage(input, selection);
  writeJsonArtifact(date, 'selection-audit', selection);
  const gatedSelection = gateSelection(selection);
  writeJsonArtifact(date, 'selection-gated', gatedSelection);
  const writerSelection = selectionForWriting(gatedSelection);
  const validateSummaryWithSourceRepair = (parsed) => validateSummary(
    repairSummaryCardSources(parsed, writerSelection, { logRepairs: false }),
  );

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
    validateSummaryWithSourceRepair,
  );
  usages.push(writeResult.usage);
  const draftSummary = repairSummaryCardSources(writeResult.parsed, writerSelection);
  validateSummary(draftSummary);
  writeJsonArtifact(date, 'draft', draftSummary);

  const explainUser = [
    'Original source JSON:',
    JSON.stringify(input, null, 2),
    '',
    'Curated selected items:',
    JSON.stringify(writerSelection, null, 2),
    '',
    'Draft renderer JSON:',
    JSON.stringify(draftSummary, null, 2),
  ].join('\n');
  const explainResult = await callJsonStep(
    date,
    'explain',
    loadPrompt('explain-system.md'),
    explainUser,
    validateSummaryWithSourceRepair,
  );
  usages.push(explainResult.usage);
  const explainedSummary = repairSummaryCardSources(explainResult.parsed, writerSelection);
  validateSummary(explainedSummary);
  validateExplanationPreservesDraft(draftSummary, explainedSummary);
  writeJsonArtifact(date, 'explained', explainedSummary);

  const noPodcastCards = dropPodcastDeferredCards(explainedSummary, podcastQueue);
  const repairedSummary = repairSummarySourceQuotes(repairSummaryCardSources(noPodcastCards, gatedSelection), input, gatedSelection);
  const summary = repairSummaryCitations(repairReportVoice(repairPrivatePhraseConcepts(repairRequiredTranslationConcepts(
    repairConceptAliases(sanitizeSummary(repairedSummary)),
    gatedSelection
  ))));
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
      'card_source_reference_repair',
      'podcast_deferral',
      'citation_source_citations_membership',
      'pseudo_citation_guard',
      'citation_bibliographic_anchor_guard',
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
