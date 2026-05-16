// LinkedIn Pulse article HTML → markdown. Pure functions.
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

function makeTurndown() {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
  });
  td.use(gfm);
  td.addRule('stripImages', { filter: 'img', replacement: () => '' });
  td.addRule('stripScripts', { filter: ['script', 'noscript', 'style'], replacement: () => '' });
  return td;
}
const turndown = makeTurndown();

// Parse a LinkedIn Pulse article HTML page. Returns {title, author, dateIso,
// bodyMd, wordCount} or null if not parseable.
export function parseArticle(html) {
  const $ = cheerio.load(html);
  const title = $('h1').first().text().trim();
  if (!title) return null;

  // JSON-LD has clean metadata when present
  let dateIso = null;
  let author = 'Jack Kruse';
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).text());
      const obj = Array.isArray(data) ? data[0] : data;
      if (obj?.datePublished) dateIso = obj.datePublished;
      if (obj?.author?.name) author = obj.author.name;
    } catch {}
  });

  // Body — `<article>` tag holds the main content
  const $article = $('article').first();
  if (!$article.length) return null;

  // Strip LinkedIn chrome inside article (related-posts widgets, share bars)
  $article.find('.reader-related-articles, .feed-shared, .share-actions, button, [data-test-id*="share"], svg').remove();

  // Convert
  let bodyMd = turndown.turndown($.html($article)).trim();
  // Cleanup: collapse multi-newlines, strip trailing spaces
  bodyMd = bodyMd
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');

  // Drop leading title if Turndown duplicated it (h1 inside <article>)
  bodyMd = bodyMd.replace(new RegExp(`^#\\s+${title.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*\\n+`), '');

  const wordCount = (bodyMd.match(/\S+/g) || []).length;
  return { title, author, dateIso, bodyMd, wordCount };
}

// Canonical URL — strip query/fragment for clean dedupe.
export function canonicalArticleUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    u.search = '';
    u.hash = '';
    let s = u.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch {
    return urlStr;
  }
}

// Filename stem from URL.
export function articleFilenameStem(urlStr) {
  try {
    const u = new URL(urlStr);
    const m = u.pathname.match(/\/pulse\/([^/]+)/);
    if (!m) return null;
    let slug = decodeURIComponent(m[1]).replace(/[\\/:*?"<>|\x00-\x1f]/g, '-');
    if (slug.length > 100) slug = slug.slice(0, 100);
    return slug || 'article';
  } catch {
    return null;
  }
}
