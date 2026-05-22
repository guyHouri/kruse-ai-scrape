// Render the daily report as standalone HTML matching the kruse-summary-v2
// visual identity (see kruse-summary-v2-20-05-2026 .html in this package).
//
// Two render paths share the same template:
//   1. Curated path: an AI summary JSON (see prompts/output-schema.json) drives
//      the cards — themed tags, bold lead, expandable concepts, source links.
//   2. Fallback path: no AI summary available → one raw card per tweet under
//      a single "Field Updates" section. Still v2-styled.
//
// The shell (header, section CSS, Ask-AI locked card, font, script) is
// identical to kruse-summary-v2; only the section content varies.

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS } from '../settings.js';
import { info, warn } from './logger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDay(date) {
  const dir = path.resolve(ROOT, SETTINGS.scrapedDataDir);
  const file = path.join(dir, `${date}.json`);
  if (!existsSync(file)) {
    warn(`no scraped file at ${file} — sending empty report`);
    return { date, handle: SETTINGS.handle, tweet_count: 0, tweets: [] };
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

function loadForumDay(date) {
  const dir = path.resolve(ROOT, SETTINGS.forumDailyDir);
  const file = path.join(dir, `${date}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function renderForumSection(forumDay, summaryForum) {
  // If the AI summary supplied a curated forum section, prefer it.
  if (summaryForum?.bullets?.length) {
    const items = summaryForum.bullets.map((b) => {
      const link = b.thread_url
        ? `<a href="${esc(b.thread_url)}" target="_blank" class="source-link">See full thread →</a>`
        : `<a href="https://forum.jackkruse.com" target="_blank" class="source-link">forum.jackkruse.com →</a>`;
      return `<li><div class="forum-item"><div class="forum-meta"><strong>${esc(b.title)}:</strong> ${link}</div><div class="item-text" style="color:#cbd5e1;font-size:0.95rem;">${esc(b.summary || '')}</div></div></li>`;
    }).join('');
    return `      <div class="section-title">Forum Insights</div>
      <div class="card"><ul class="bullet-list">${items}</ul></div>`;
  }
  // Fallback: raw scraped posts (no curation).
  if (!forumDay?.posts?.length) return '';
  const items = forumDay.posts.slice(0, 8).map((p) => {
    const meta = [p.author && `@${p.author}`, p.forum_name].filter(Boolean).join(' · ');
    return `<li>
      <div class="forum-item">
        <div class="forum-meta">
          <strong>${esc(p.thread_title)}:</strong>
          <a href="${esc(p.thread_url)}" target="_blank" class="source-link">See full thread →</a>
        </div>
        <div class="item-text" style="color:#9ca3af;font-size:0.85rem;">${esc(meta)}</div>
      </div>
    </li>`;
  }).join('');
  return `      <div class="section-title">Forum Insights (${forumDay.posts.length} new in last ${forumDay.window_hours || 24}h)</div>
      <div class="card"><ul class="bullet-list">${items}</ul></div>`;
}

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cleanText(text) {
  return String(text || '').replace(/\s*https?:\/\/t\.co\/\S+\s*$/g, '').trim();
}

function formatDdMmYyyy(date) {
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
}

// Renders `body` text. Any token "{{concept:Some Term}}" becomes an
// inline `<span class="expandable-concept" onclick="toggleConcept('id')">Some Term</span>`.
// The matching expanded block is rendered separately right after the body.
function renderBodyWithConcepts(body, concepts, cardIdx) {
  const usedConceptIds = [];
  const safeBody = String(body || '');
  // First escape the body, then re-insert markup for concept tokens.
  // We escape on the literal-text parts and inject HTML for the markers.
  let out = '';
  const re = /\{\{concept:([^}]+?)\}\}/g;
  let last = 0;
  let m;
  let n = 0;
  while ((m = re.exec(safeBody))) {
    out += esc(safeBody.slice(last, m.index));
    const term = m[1].trim();
    const id = `c-${cardIdx}-${n++}`;
    usedConceptIds.push({ id, term });
    out += `<span class="expandable-concept" onclick="toggleConcept('${id}')">${esc(term)}</span>`;
    last = m.index + m[0].length;
  }
  out += esc(safeBody.slice(last));

  // Expanded blocks come right after the body, in insertion order.
  const expanded = usedConceptIds.map(({ id, term }) => {
    const explainer = concepts?.[term];
    if (!explainer) return '';
    return `<div id="${id}" class="expanded-content">
      <strong>${esc(term)}:</strong> ${esc(explainer)}
    </div>`;
  }).join('\n');
  return { html: out, expanded };
}

function renderCuratedCard(card, idx) {
  const { html: bodyHtml, expanded } = renderBodyWithConcepts(card.body, card.concepts, idx);
  const sourceLink = (card.source_urls && card.source_urls[0])
    || (card.source_ids && card.source_ids[0] && `https://x.com/i/status/${card.source_ids[0]}`)
    || 'https://x.com/DrJackKruse';
  const lead = card.lead ? `<strong>${esc(card.lead)}</strong> ` : '';
  const quote = card.source_quote
    ? `<div class="source-quote">${esc(card.source_quote)}</div>`
    : '';
  return `      <div class="card">
        <div class="card-header">
          <span class="tag">${esc(card.tag || 'Update')}</span>
          <a href="${esc(sourceLink)}" target="_blank" class="source-link">Read full source →</a>
        </div>
        <div class="item-text">${lead}${bodyHtml}</div>
        ${expanded}
        ${quote}
      </div>`;
}

function renderFallbackTweetCard(t, idx) {
  const tag = t.is_retweet ? 'Retweet'
    : t.is_quote ? 'Quote'
    : t.is_reply ? 'Reply'
    : 'Post';
  const body = esc(cleanText(t.text));
  const sourceLink = esc(t.url || `https://x.com/DrJackKruse/status/${t.id}`);
  let quoted = '';
  if (t.quoted_tweet) {
    const q = t.quoted_tweet;
    quoted = `<div class="source-quote">
      <strong>@${esc(q.author?.username || 'unknown')}:</strong> ${esc(cleanText(q.text))}
    </div>`;
  }
  return `      <div class="card">
        <div class="card-header">
          <span class="tag">${esc(tag)}</span>
          <a href="${sourceLink}" target="_blank" class="source-link">Read full source →</a>
        </div>
        <div class="item-text">${body}</div>
        ${quoted}
      </div>`;
}

// Curated summary shape (validated against prompts/output-schema.json):
//   { headline_subtitle, sections: [ { title, cards: [...] } ] }
function renderSections(summary) {
  return summary.sections.map((sec) => {
    const cards = sec.cards.map((c, i) => renderCuratedCard(c, i)).join('\n');
    return `      <div class="section-title">${esc(sec.title)}</div>
${cards}`;
  }).join('\n');
}

function renderFallbackSections(day) {
  const cards = (day.tweets || []).map((t, i) => renderFallbackTweetCard(t, i)).join('\n');
  const empty = `<div class="card"><div class="item-text" style="color:#9ca3af;text-align:center;">No tweets in this window.</div></div>`;
  return `      <div class="section-title">Field Updates (${day.tweets?.length || 0} from @${esc(day.handle || 'DrJackKruse')})</div>
${day.tweets?.length ? cards : empty}`;
}

// `date` = "YYYY-MM-DD". `summary` (optional) = parsed AI summary JSON.
// If `summary` is omitted, falls back to raw tweet cards.
export function buildReportHtml(date, summary = null) {
  const day = loadDay(date);
  const forumDay = loadForumDay(date);
  const dateDisplay = formatDdMmYyyy(date);
  const subtitle = summary?.headline_subtitle || 'Cutting-edge biophysical vectors. No entry-level fluff.';
  const twitterHtml = summary?.sections?.length
    ? renderSections(summary)
    : renderFallbackSections(day);
  const forumHtml = renderForumSection(forumDay, summary?.forum);
  const sectionsHtml = [twitterHtml, forumHtml].filter(Boolean).join('\n');
  info(`built report for ${date}: ${summary ? `${summary.sections.length} section(s) curated` : `${day.tweets?.length || 0} raw tweets`}${forumDay ? ` + ${forumDay.posts?.length || 0} forum posts` : ''}`);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Kruse Report ${dateDisplay}</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg-color: #0b0f19;
      --card-bg: #151c2c;
      --text-color: #f3f4f6;
      --text-muted: #9ca3af;
      --accent-color: #3b82f6;
      --accent-hover: #60a5fa;
      --locked-color: #4b5563;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', sans-serif; }
    body { background-color: var(--bg-color); color: var(--text-color); padding: 40px 20px; display: flex; justify-content: center; align-items: flex-start; min-height: 100vh; }
    .container { width: 100%; max-width: 650px; display: flex; flex-direction: column; gap: 20px; }
    header { text-align: center; margin-bottom: 10px; }
    h1 { font-size: 2.3rem; font-weight: 700; letter-spacing: -0.5px; background: linear-gradient(45deg, #3b82f6, #9333ea); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; color: transparent; margin-bottom: 4px; }
    .subtitle { font-size: 1rem; color: var(--text-muted); font-weight: 300; }
    .section-title { font-size: 1.3rem; font-weight: 700; color: var(--accent-hover); border-bottom: 1px solid #24314b; padding-bottom: 6px; margin-top: 10px; }
    .card { background-color: var(--card-bg); border: 1px solid #202b42; border-radius: 12px; padding: 16px 20px; display: flex; flex-direction: column; gap: 10px; transition: border-color 0.2s ease; }
    .card:hover { border-color: #2e3e5f; }
    .card-header { display: flex; justify-content: space-between; align-items: center; }
    .tag { background-color: #1e293b; color: #3b82f6; padding: 2px 10px; border-radius: 20px; font-size: 0.8rem; font-weight: 600; }
    .source-link { font-size: 0.8rem; color: var(--text-muted); text-decoration: none; border-bottom: 1px dashed var(--text-muted); transition: all 0.2s ease; }
    .source-link:hover { color: var(--accent-hover); border-bottom-color: var(--accent-hover); }
    .item-text { font-size: 1rem; line-height: 1.45; color: #e5e7eb; }
    .source-quote { background: #0f1524; border-left: 3px solid #4b5563; border-radius: 4px 8px 8px 4px; padding: 10px 14px; font-style: italic; font-size: 0.92rem; color: #9ca3af; }
    .bullet-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 10px; }
    .bullet-list li { position: relative; padding-left: 18px; line-height: 1.45; font-size: 1rem; }
    .bullet-list li::before { content: "•"; color: var(--accent-color); font-weight: bold; position: absolute; left: 0; top: 0; }
    .forum-item { display: flex; flex-direction: column; gap: 4px; }
    .forum-meta { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; }
    .expandable-concept { color: #60a5fa; border-bottom: 1px dashed #60a5fa; cursor: pointer; font-weight: 600; }
    .expanded-content { max-height: 0; overflow: hidden; background-color: #0f1524; border-radius: 6px; padding: 0 12px; transition: max-height 0.25s ease, padding 0.25s ease, margin 0.25s ease; font-size: 0.9rem; color: #cbd5e1; }
    .expanded-content.open { max-height: 400px; padding: 10px 12px; margin-top: 6px; border-left: 3px solid #3b82f6; }
    .locked-section { background: linear-gradient(180deg, var(--card-bg) 0%, #111622 100%); border: 1px dashed #2d3748; border-radius: 12px; padding: 24px; text-align: center; opacity: 0.8; }
    .locked-title { font-size: 1.1rem; font-weight: 600; color: var(--locked-color); margin-bottom: 4px; }
    .locked-badge { font-size: 0.7rem; background-color: #27272a; color: #a1a1aa; padding: 1px 6px; border-radius: 4px; font-weight: 700; margin-left: 6px; }
    footer { text-align: center; color: #6b7280; font-size: 0.75rem; margin-top: 12px; }
    footer a { color: #6b7280; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Kruse Report ${dateDisplay}</h1>
      <div class="subtitle">${esc(subtitle)}</div>
    </header>
${sectionsHtml}
    <div class="locked-section">
      <div class="locked-title">
        <span>Interact with Report (Ask AI)</span>
        <span class="locked-badge">Soon</span>
      </div>
    </div>
    <footer>
      Auto-generated by <a href="https://github.com/guyHouri/kruse-ai-scrape">kruse-ai-scrape</a>.
      Source: <a href="https://x.com/${esc(day.handle || 'DrJackKruse')}">@${esc(day.handle || 'DrJackKruse')}</a>.
    </footer>
  </div>
  <script>
    function toggleConcept(id) {
      var el = document.getElementById(id);
      if (el) el.classList.toggle('open');
    }
  </script>
</body>
</html>`;
}
