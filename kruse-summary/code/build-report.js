// Render the daily report as standalone HTML.
//
// Reads ../twitter_to_md/data/<date>.json, builds one card per tweet in the
// "Field Updates" section, mirroring kruse-summary-v2 visual style.
//
// AI summarization (themed cards, expandable concepts) is deferred — TODO
// hook later via an LLM call that returns a structured cards[] array, then
// swap renderCards() to consume that.

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
    return { tweet_count: 0, tweets: [] };
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

// Lightweight HTML escape for tweet text. We don't try to render entities,
// hashtags, or links specially — they stay as raw text inside an <a> source link.
function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Strip the auto-appended pic.twitter.com / t.co link from a tweet body, since
// we already render media URLs / a separate source link. Keeps the card clean.
function cleanText(text) {
  return text.replace(/\s*https:\/\/t\.co\/\S+\s*$/g, '').trim();
}

function tagForTweet(t) {
  if (t.is_retweet) return 'Retweet';
  if (t.is_quote) return 'Quote';
  if (t.is_reply) return 'Reply';
  return 'Post';
}

function renderTweetCard(t) {
  const text = esc(cleanText(t.text));
  const tag = tagForTweet(t);
  const url = esc(t.url);
  let quotedBlock = '';
  if (t.quoted_tweet) {
    const q = t.quoted_tweet;
    quotedBlock = `
        <div class="quoted">
          <div class="quoted-author">@${esc(q.author?.username || 'unknown')}</div>
          <div class="quoted-text">${esc(cleanText(q.text))}</div>
          <a href="${esc(q.url)}" target="_blank" class="source-link">View quoted →</a>
        </div>`;
  }
  let replyContext = '';
  if (t.is_reply && t.thread_context?.length) {
    const items = t.thread_context.map((p) => `
          <li>
            <span class="reply-author">@${esc(p.author?.username || 'unknown')}:</span>
            ${esc(cleanText(p.text))}
          </li>`).join('');
    replyContext = `
        <details class="thread">
          <summary>Thread context (${t.thread_context.length})</summary>
          <ul class="thread-list">${items}</ul>
        </details>`;
  }
  return `
      <div class="card">
        <div class="card-header">
          <span class="tag">${esc(tag)}</span>
          <a href="${url}" target="_blank" class="source-link">Read on X →</a>
        </div>
        <div class="item-text">${text}</div>${quotedBlock}${replyContext}
      </div>`;
}

function formatDdMmYyyy(date) {
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
}

export function buildReportHtml(date) {
  const day = loadDay(date);
  const cards = (day.tweets || []).map(renderTweetCard).join('\n');
  const dateDisplay = formatDdMmYyyy(date);
  info(`built report for ${date}: ${day.tweets?.length || 0} tweets`);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Kruse Report ${dateDisplay}</title>
    <style>
      body { background-color: #0b0f19; color: #f3f4f6; padding: 40px 20px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; }
      .container { max-width: 650px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
      header { text-align: center; margin-bottom: 10px; }
      h1 { font-size: 2.3rem; font-weight: 700; letter-spacing: -0.5px; background: linear-gradient(45deg, #3b82f6, #9333ea); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; color: transparent; margin: 0 0 4px 0; }
      .subtitle { font-size: 1rem; color: #9ca3af; font-weight: 300; }
      .section-title { font-size: 1.3rem; font-weight: 700; color: #60a5fa; border-bottom: 1px solid #24314b; padding-bottom: 6px; margin-top: 10px; }
      .card { background-color: #151c2c; border: 1px solid #202b42; border-radius: 12px; padding: 16px 20px; display: flex; flex-direction: column; gap: 10px; }
      .card-header { display: flex; justify-content: space-between; align-items: center; }
      .tag { background-color: #1e293b; color: #3b82f6; padding: 2px 10px; border-radius: 20px; font-size: 0.8rem; font-weight: 600; }
      .source-link { font-size: 0.8rem; color: #9ca3af; text-decoration: none; border-bottom: 1px dashed #9ca3af; }
      .item-text { font-size: 1rem; line-height: 1.45; color: #e5e7eb; white-space: pre-wrap; }
      .quoted { background: #0f1524; border-left: 3px solid #3b82f6; border-radius: 6px; padding: 10px 12px; font-size: 0.9rem; color: #cbd5e1; display: flex; flex-direction: column; gap: 4px; }
      .quoted-author { font-weight: 600; color: #60a5fa; }
      .thread { font-size: 0.85rem; color: #cbd5e1; }
      .thread summary { cursor: pointer; color: #60a5fa; }
      .thread-list { padding-left: 16px; margin-top: 6px; display: flex; flex-direction: column; gap: 6px; }
      .reply-author { font-weight: 600; color: #60a5fa; }
      .empty { background: #151c2c; border: 1px dashed #2d3748; border-radius: 12px; padding: 24px; text-align: center; color: #9ca3af; }
      footer { text-align: center; color: #6b7280; font-size: 0.75rem; margin-top: 30px; }
      footer a { color: #6b7280; }
    </style>
  </head>
  <body>
    <div class="container">
      <header>
        <h1>Kruse Daily ${dateDisplay}</h1>
        <div class="subtitle">Cutting-edge biophysical vectors. No entry-level fluff.</div>
      </header>

      <div class="section-title">Field Updates (${day.tweets?.length || 0} from @${esc(day.handle || 'DrJackKruse')})</div>
      ${day.tweets?.length ? cards : '<div class="empty">No tweets in this window.</div>'}

      <footer>
        Auto-generated by <a href="https://github.com/guyhouri/kruse-ai-scrape">kruse-ai-scrape</a>.
        Source: <a href="https://x.com/${esc(day.handle || 'DrJackKruse')}">@${esc(day.handle || 'DrJackKruse')}</a>.
      </footer>
    </div>
  </body>
</html>`;
}
