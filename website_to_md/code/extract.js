import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import {
  GLOBAL_BOILERPLATE_TAGS,
  CLASS_TOKEN_BLOCKLIST,
  ID_BLOCKLIST,
  CONTENT_SELECTORS,
  MIN_MARKDOWN_CHARS,
} from '../settings.js';

function makeTurndown() {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
  });
  td.use(gfm);
  td.addRule('stripImages', {
    filter: 'img',
    replacement: () => '',
  });
  return td;
}

const turndown = makeTurndown();

function stripGlobalBoilerplate($) {
  $(GLOBAL_BOILERPLATE_TAGS).remove();
}

function stripInlineBoilerplate($, root) {
  root.find('*').each((_, el) => {
    const $el = $(el);
    const classAttr = $el.attr('class') || '';
    const idAttr = ($el.attr('id') || '').toLowerCase();
    if (idAttr && ID_BLOCKLIST.has(idAttr)) { $el.remove(); return; }
    const tokens = classAttr.split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
    for (const tok of tokens) {
      if (CLASS_TOKEN_BLOCKLIST.has(tok)) { $el.remove(); return; }
    }
  });
}

function pickContentRoot($) {
  for (const sel of CONTENT_SELECTORS) {
    const node = $(sel).first();
    if (node.length && node.text().trim().length > 200) {
      return node;
    }
  }
  return $('body');
}

function extractTitle($) {
  const h1 = $('h1').first().text().trim();
  if (h1) return h1;
  const ogTitle = $('meta[property="og:title"]').attr('content');
  if (ogTitle) return ogTitle.trim();
  const title = $('title').first().text().trim();
  return title || 'Untitled';
}

export function htmlToArticle(html) {
  const $ = cheerio.load(html);
  const title = extractTitle($);

  stripGlobalBoilerplate($);
  const root = pickContentRoot($);
  stripInlineBoilerplate($, root);

  const rootHtml = $.html(root);
  let body = turndown.turndown(rootHtml).trim();

  body = body
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n');

  if (body.length < MIN_MARKDOWN_CHARS) return null;

  return { title, body };
}

export function renderArticleSection({ title, body, sourceUrl }) {
  return `## ${title}\n\n**Source:** <${sourceUrl}>\n\n${body}\n`;
}

// Decode percent-encoded UTF-8 (e.g. Hebrew slugs) for human-readable display
// next to the raw URL. Returns null if the URL has no percent-encoding to decode
// or if decoding fails (broken sequences). The raw URL stays canonical for
// fetching; the decoded form is purely a display affordance for Amit + NotebookLM.
function decodeForDisplay(url) {
  if (!/%[0-9A-Fa-f]{2}/.test(url)) return null;
  try {
    const decoded = decodeURI(url);
    return decoded === url ? null : decoded;
  } catch {
    return null;
  }
}

export function renderSiteHeader({ slug, displayHost, seedUrl, seedUrls, scrapedAt, totalArticles }) {
  const seeds = seedUrls?.length ? seedUrls : [seedUrl];
  const yamlSeedLines = seeds.length === 1
    ? [`seed_url: ${seeds[0]}`]
    : ['seed_urls:', ...seeds.map((u) => `  - ${u}`)];

  // Emit a Sources block under the H1 so each chunk retrieved by NotebookLM
  // has a clear list of entry points. Show the decoded Hebrew form alongside
  // the raw URL when applicable so a human skimming the file can read it.
  const sourceLines = seeds.length === 1
    ? (() => {
        const decoded = decodeForDisplay(seeds[0]);
        return decoded
          ? [`**Source:** <${seeds[0]}> (${decoded})`]
          : [`**Source:** <${seeds[0]}>`];
      })()
    : ['**Sources:**', '', ...seeds.map((u) => {
        const decoded = decodeForDisplay(u);
        return decoded ? `- <${u}> (${decoded})` : `- <${u}>`;
      })];

  return [
    '---',
    `slug: ${slug}`,
    `site: ${displayHost}`,
    ...yamlSeedLines,
    `scraped_at: ${scrapedAt}`,
    `total_articles: ${totalArticles}`,
    '---',
    '',
    `# ${displayHost}`,
    '',
    ...sourceLines,
    '',
    `Generated knowledge base for NotebookLM. Each article below preserves its original source URL on a \`**Source:**\` line directly under the heading.`,
    '',
    '---',
    '',
  ].join('\n');
}
