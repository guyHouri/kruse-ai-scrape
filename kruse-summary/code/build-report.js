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
  // Curated path (preferred): AI/hand summary supplied themed bullets.
  if (summaryForum?.bullets?.length) {
    let conceptCursor = 1000; // separate id-namespace from twitter cards
    const items = summaryForum.bullets.map((b) => {
      const link = b.thread_url
        ? `<a href="${esc(b.thread_url)}" target="_blank" class="source-link">See full thread →</a>`
        : `<a href="https://forum.jackkruse.com" target="_blank" class="source-link">forum.jackkruse.com →</a>`;
      const { html: bodyHtml, expanded } = renderBodyWithConcepts(b.summary || '', b.concepts || {}, conceptCursor++);
      return `<li>
        <div class="forum-item">
          <div class="forum-meta">
            <strong>${esc(b.title)}:</strong>
            ${link}
          </div>
          <div class="item-text" style="color:var(--text-soft);font-size:0.95rem;">${bodyHtml}</div>
          ${expanded}
        </div>
      </li>`;
    }).join('');
    return `      <div class="section-title">Forum Updates</div>
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
        <div class="item-text" style="color:var(--text-muted);font-size:0.85rem;">${esc(meta)}</div>
      </div>
    </li>`;
  }).join('');
  return `      <div class="section-title">Forum Updates (${forumDay.posts.length} new in last ${forumDay.window_hours || 24}h)</div>
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

// Inline markdown bold: `**text**` → `<strong>text</strong>`. Applied AFTER esc()
// so the <strong> tags stay live but the inner text remains escaped.
function escBold(s) {
  return esc(s).replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
}

function cleanText(text) {
  return String(text || '').replace(/\s*https?:\/\/t\.co\/\S+\s*$/g, '').trim();
}

function formatDdMmYyyy(date) {
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
}

// Concept entry can be either a plain string explainer (legacy) or an
// object { level, text }. Legacy defaults to level: pro.
function conceptInfo(entry) {
  if (entry == null) return null;
  if (typeof entry === 'string') return { level: 'pro', text: entry };
  return { level: entry.level || 'pro', text: entry.text || '' };
}

// Renders `body` text. Any token "{{concept:Some Term}}" becomes an
// inline `<span class="expandable-concept" data-concept-level="...">`.
// Reader-level CSS may visually downgrade the chip to plain text.
function renderBodyWithConcepts(body, concepts, cardIdx) {
  const usedConceptIds = [];
  const safeBody = String(body || '');
  let out = '';
  const re = /\{\{concept:([^}]+?)\}\}/g;
  let last = 0;
  let m;
  let n = 0;
  while ((m = re.exec(safeBody))) {
    out += escBold(safeBody.slice(last, m.index));
    const term = m[1].trim();
    const id = `c-${cardIdx}-${n++}`;
    const info = conceptInfo(concepts?.[term]);
    const level = info?.level || 'pro';
    usedConceptIds.push({ id, term, level, info });
    out += `<span class="expandable-concept" data-concept-level="${esc(level)}" onclick="toggleConcept('${id}')">${esc(term)}</span>`;
    last = m.index + m[0].length;
  }
  out += escBold(safeBody.slice(last));

  const expanded = usedConceptIds.map(({ id, term, level, info }) => {
    if (!info?.text) return '';
    return `<div id="${id}" class="expanded-content" data-concept-level="${esc(level)}">
      <strong>${esc(term)}:</strong> ${esc(info.text)}
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

  // Points: array of strings → bullet list. Each point can itself contain
  // {{concept:Term}} markers — wire through same expander. We keep the
  // expanded chips inside the points container so they don't add flex-gap
  // at the card level when collapsed.
  let pointsBlock = '';
  if (Array.isArray(card.points) && card.points.length) {
    let pointsExpanded = '';
    const items = card.points.map((p, i) => {
      const { html, expanded: ex } = renderBodyWithConcepts(p, card.concepts, idx * 100 + i);
      pointsExpanded += ex;
      return `<li>${html}</li>`;
    }).join('');
    pointsBlock = `<div class="card-points"><ul class="bullet-list">${items}</ul>${pointsExpanded}</div>`;
  }

  // Citations footer.
  let citationsHtml = '';
  if (Array.isArray(card.citations) && card.citations.length) {
    const items = card.citations.map((c) => {
      const claim = c.claim ? `<div class="citation-claim">${esc(c.claim)}</div>` : '';
      return `<li class="citation"><div class="citation-paper">${esc(c.paper || '')}</div>${claim}</li>`;
    }).join('');
    citationsHtml = `<div class="citations"><div class="citations-label">Citations</div><ul>${items}</ul></div>`;
  }

  const quote = card.source_quote
    ? `<div class="source-quote">${esc(card.source_quote)}</div>`
    : '';

  // Build the card by joining only the present sections. Empty strings get
  // filtered out so flex `gap` doesn't apply between phantom items.
  const bodyBlock = `<div class="card-body"><div class="item-text">${lead}${bodyHtml}</div>${expanded}</div>`;
  const sections = [
    `<div class="card-header"><span class="tag">${esc(card.tag || 'Update')}</span><a href="${esc(sourceLink)}" target="_blank" class="source-link">Read full source →</a></div>`,
    bodyBlock,
    pointsBlock,
    citationsHtml,
    quote,
  ].filter(Boolean).join('');

  return `      <div class="card">${sections}</div>`;
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
  return `      <div class="section-title">Twitter Updates (${day.tweets?.length || 0} from @${esc(day.handle || 'DrJackKruse')})</div>
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
  // Forum section gated: only render when the env flag is on AND we have
  // forum data. User wants to validate forum data quality before letting it
  // into the daily mail. Scrape still runs daily so we accumulate state.
  const includeForum = process.env.INCLUDE_FORUM === 'true';
  const forumHtml = includeForum ? renderForumSection(forumDay, summary?.forum) : '';
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
    /* Dark theme (default) */
    :root {
      --bg-color: #0b0f19;
      --card-bg: #151c2c;
      --card-border: #202b42;
      --card-border-hover: #2e3e5f;
      --section-rule: #24314b;
      --text-color: #f3f4f6;
      --text-soft: #cbd5e1;
      --text-body: #e5e7eb;
      --text-muted: #9ca3af;
      --accent-color: #3b82f6;
      --accent-hover: #60a5fa;
      --locked-color: #4b5563;
      --tag-bg: #1e293b;
      --quote-bg: #0f1524;
      --quote-rule: #4b5563;
      --expanded-bg: #0f1524;
      --locked-grad-start: #151c2c;
      --locked-grad-end: #111622;
      --locked-dash: #2d3748;
      --locked-badge-bg: #27272a;
      --locked-badge-fg: #a1a1aa;
      --footer-color: #6b7280;
      --toggle-bg: rgba(255,255,255,0.06);
      --toggle-border: rgba(255,255,255,0.12);
    }
    /* Light theme — toggled by class on <body> */
    body.light {
      --bg-color: #f9fafb;
      --card-bg: #ffffff;
      --card-border: #e5e7eb;
      --card-border-hover: #cbd5e1;
      --section-rule: #e5e7eb;
      --text-color: #0f172a;
      --text-soft: #334155;
      --text-body: #1f2937;
      --text-muted: #6b7280;
      --accent-color: #2563eb;
      --accent-hover: #1d4ed8;
      --locked-color: #94a3b8;
      --tag-bg: #eff6ff;
      --quote-bg: #f1f5f9;
      --quote-rule: #cbd5e1;
      --expanded-bg: #f1f5f9;
      --locked-grad-start: #ffffff;
      --locked-grad-end: #f3f4f6;
      --locked-dash: #cbd5e1;
      --locked-badge-bg: #e5e7eb;
      --locked-badge-fg: #475569;
      --footer-color: #94a3b8;
      --toggle-bg: rgba(0,0,0,0.04);
      --toggle-border: rgba(0,0,0,0.12);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', sans-serif; }
    body { background-color: var(--bg-color); color: var(--text-color); padding: 40px 20px; display: flex; justify-content: center; align-items: flex-start; min-height: 100vh; transition: background-color 0.2s ease, color 0.2s ease; }
    .container { width: 100%; max-width: 650px; display: flex; flex-direction: column; gap: 20px; }
    header { text-align: center; margin-bottom: 10px; position: relative; padding-top: 48px; }
    h1 { font-size: 2.3rem; font-weight: 700; letter-spacing: -0.5px; background: linear-gradient(45deg, #3b82f6, #9333ea); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; color: transparent; margin-bottom: 4px; }
    .subtitle { font-size: 1rem; color: var(--text-muted); font-weight: 300; }
    .theme-toggle { position: absolute; top: 0; right: 0; background: var(--toggle-bg); border: 1px solid var(--toggle-border); color: var(--text-color); cursor: pointer; padding: 6px 10px; border-radius: 20px; font-size: 0.85rem; line-height: 1; transition: background 0.2s ease; }
    .theme-toggle:hover { background: var(--card-border); }
    .level-toggle { position: absolute; top: 0; left: 0; display: flex; gap: 4px; background: var(--toggle-bg); border: 1px solid var(--toggle-border); border-radius: 20px; padding: 3px; }
    .level-toggle button { background: transparent; color: var(--text-muted); border: none; cursor: pointer; padding: 4px 10px; border-radius: 16px; font-size: 0.8rem; font-weight: 600; transition: background 0.15s ease, color 0.15s ease; }
    .level-toggle button.active { background: var(--accent-color); color: #fff; }
    .level-toggle button:hover:not(.active) { color: var(--text-color); }
    /* Concept-level gating: pro reader hides noob-only chips; hacker hides all. */
    body.level-pro .expandable-concept[data-concept-level="noob"],
    body.level-hacker .expandable-concept[data-concept-level] {
      color: inherit; border-bottom: none; cursor: default; font-weight: inherit; pointer-events: none;
    }
    body.level-pro .expanded-content[data-concept-level="noob"],
    body.level-hacker .expanded-content { display: none !important; }
    .section-title { font-size: 1.3rem; font-weight: 700; color: var(--accent-hover); border-bottom: 1px solid var(--section-rule); padding-bottom: 6px; margin-top: 10px; }
    .card { background-color: var(--card-bg); border: 1px solid var(--card-border); border-radius: 12px; padding: 14px 18px; display: flex; flex-direction: column; gap: 8px; transition: border-color 0.2s ease, background-color 0.2s ease; }
    .card-body, .card-points { display: flex; flex-direction: column; gap: 4px; }
    .card-points ul { margin: 0; }
    .card:hover { border-color: var(--card-border-hover); }
    .card-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
    .tag { background-color: var(--tag-bg); color: var(--accent-color); padding: 2px 10px; border-radius: 20px; font-size: 0.8rem; font-weight: 600; }
    .source-link { font-size: 0.8rem; color: var(--text-muted); text-decoration: none; border-bottom: 1px dashed var(--text-muted); transition: all 0.2s ease; }
    .source-link:hover { color: var(--accent-hover); border-bottom-color: var(--accent-hover); }
    .item-text { font-size: 1rem; line-height: 1.45; color: var(--text-body); }
    .source-quote { background: var(--quote-bg); border-left: 3px solid var(--quote-rule); border-radius: 4px 8px 8px 4px; padding: 10px 14px; font-style: italic; font-size: 0.92rem; color: var(--text-muted); }
    .citations { padding: 8px 12px; background: var(--quote-bg); border-radius: 8px; }
    .citations-label { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; color: var(--accent-hover); letter-spacing: 0.04em; margin-bottom: 6px; }
    .citations ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
    .citation-paper { font-size: 0.85rem; color: var(--text-body); font-weight: 600; }
    .citation-claim { font-size: 0.82rem; color: var(--text-muted); line-height: 1.4; margin-top: 2px; }
    .bullet-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 10px; }
    .bullet-list li { position: relative; padding-left: 18px; line-height: 1.45; font-size: 1rem; }
    .bullet-list li::before { content: "•"; color: var(--accent-color); font-weight: bold; position: absolute; left: 0; top: 0; }
    .forum-item { display: flex; flex-direction: column; gap: 4px; }
    .forum-meta { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; }
    .expandable-concept { color: var(--accent-hover); border-bottom: 1px dashed var(--accent-hover); cursor: pointer; font-weight: 600; }
    .expanded-content { max-height: 0; overflow: hidden; background-color: var(--expanded-bg); border-radius: 6px; padding: 0 12px; margin: 0; transition: max-height 0.25s ease, padding 0.25s ease, margin 0.25s ease; font-size: 0.9rem; color: var(--text-soft); }
    .expanded-content.open { max-height: 500px; padding: 10px 12px; margin-top: 4px; margin-bottom: 4px; border-left: 3px solid var(--accent-color); }
    .locked-section { background: linear-gradient(180deg, var(--locked-grad-start) 0%, var(--locked-grad-end) 100%); border: 1px dashed var(--locked-dash); border-radius: 12px; padding: 24px; text-align: center; opacity: 0.85; }
    .locked-title { font-size: 1.1rem; font-weight: 600; color: var(--locked-color); margin-bottom: 4px; }
    .locked-badge { font-size: 0.7rem; background-color: var(--locked-badge-bg); color: var(--locked-badge-fg); padding: 1px 6px; border-radius: 4px; font-weight: 700; margin-left: 6px; }
    footer { text-align: center; color: var(--footer-color); font-size: 0.75rem; margin-top: 12px; }
    footer a { color: var(--footer-color); }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="level-toggle" role="tablist" aria-label="Reader knowledge level">
        <button type="button" data-level="noob"   aria-pressed="false">Noob</button>
        <button type="button" data-level="pro"    aria-pressed="true">Pro</button>
        <button type="button" data-level="hacker" aria-pressed="false">Hacker</button>
      </div>
      <button type="button" class="theme-toggle" id="themeToggle" aria-label="Toggle dark/light mode">🌙 Dark</button>
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
    (function () {
      var btn = document.getElementById('themeToggle');
      var saved = null;
      try { saved = localStorage.getItem('kruse-theme'); } catch (e) {}
      if (saved === 'light') document.body.classList.add('light');
      function syncLabel() {
        if (!btn) return;
        btn.textContent = document.body.classList.contains('light') ? '☀ Light' : '🌙 Dark';
      }
      syncLabel();
      if (btn) btn.addEventListener('click', function () {
        document.body.classList.toggle('light');
        try { localStorage.setItem('kruse-theme', document.body.classList.contains('light') ? 'light' : 'dark'); } catch (e) {}
        syncLabel();
      });
    })();
    (function () {
      var savedLevel = null;
      try { savedLevel = localStorage.getItem('kruse-level'); } catch (e) {}
      var initial = (savedLevel === 'noob' || savedLevel === 'pro' || savedLevel === 'hacker') ? savedLevel : 'pro';
      function apply(level) {
        document.body.classList.remove('level-noob', 'level-pro', 'level-hacker');
        document.body.classList.add('level-' + level);
        var btns = document.querySelectorAll('.level-toggle button');
        for (var i = 0; i < btns.length; i++) {
          var on = btns[i].getAttribute('data-level') === level;
          btns[i].classList.toggle('active', on);
          btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        try { localStorage.setItem('kruse-level', level); } catch (e) {}
      }
      apply(initial);
      var btns = document.querySelectorAll('.level-toggle button');
      for (var i = 0; i < btns.length; i++) {
        (function (b) {
          b.addEventListener('click', function () { apply(b.getAttribute('data-level')); });
        })(btns[i]);
      }
    })();
  </script>
</body>
</html>`;
}
