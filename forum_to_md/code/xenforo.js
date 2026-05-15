// XenForo HTML parsing primitives. Pure functions: HTML in, structured data out.
// Decoupled from networking so the discover/extract stages can test parsing
// against saved HTML if needed.

import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { normalizeUrl, canonicalThreadUrl, threadIdFromUrl } from './url-utils.js';

// --- Markdown converter (post bodies) ---

function makeTurndown() {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
  });
  td.use(gfm);
  // Strip images — NotebookLM can't ingest them anyway, and they bloat the
  // markdown with long base64 / CDN URLs. If we ever want image links, drop
  // this rule.
  td.addRule('stripImages', {
    filter: 'img',
    replacement: () => '',
  });
  // XenForo wraps quotes with an expandable "Click to expand..." trigger.
  // The trigger element has class .bbCodeBlock-expandLink — strip it so it
  // doesn't pollute the markdown blockquote.
  td.addRule('stripExpandTrigger', {
    filter: (node) => {
      if (node.nodeName !== 'DIV') return false;
      const cls = node.getAttribute('class') || '';
      return cls.includes('bbCodeBlock-expandLink');
    },
    replacement: () => '',
  });
  return td;
}

const turndown = makeTurndown();

// --- Subforum index parsing ---

// Given the HTML of the forum index page (https://forum.jackkruse.com/),
// return a flat list of { url, name } for every subforum. Categories
// (.node--category) are skipped; only leaf forums (.node--forum) are kept.
export function parseSubforumIndex(html, baseUrl) {
  const $ = cheerio.load(html);
  const out = [];
  $('.node.node--forum').each((_, el) => {
    const $el = $(el);
    const a = $el.find('h3.node-title a').first();
    const href = a.attr('href');
    const name = a.text().trim();
    if (!href || !name) return;
    const url = normalizeUrl(href, baseUrl);
    if (!url) return;
    out.push({ url, name });
  });
  return out;
}

// --- Subforum page parsing (sticky thread harvesting) ---

// Given the HTML of a subforum index page (/forums/<slug>.<id>/), return
// the pinned/sticky threads in that subforum. XenForo marks stickies by:
//   (a) wrapper class `is-sticky` on .structItem--thread
//   (b) explicit container .structItemContainer-group--sticky enclosing them
//   (c) an icon `.structItem-status--sticky` or `i.fa-thumbtack`
// We accept any of these to be defensive across XenForo template variations.
export function parsePinnedThreads(html, subforumUrl, subforumName) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();

  $('.structItem--thread').each((_, el) => {
    const $el = $(el);
    const wrapperClasses = $el.attr('class') || '';
    const inStickyContainer = $el.parents('.structItemContainer-group--sticky').length > 0;
    const hasStickyClass = /\bis-sticky\b/.test(wrapperClasses);
    const hasStickyIcon =
      $el.find('.structItem-status--sticky').length > 0 ||
      $el.find('i.fa-thumbtack').length > 0;

    if (!(inStickyContainer || hasStickyClass || hasStickyIcon)) return;

    // The thread title link is .structItem-title > a (the primary anchor —
    // there can be secondary anchors for "unread" jump etc., distinguished by
    // data-tp-primary="on" on the canonical one).
    const $title = $el.find('.structItem-title a').filter((_, a) => {
      const $a = $(a);
      const href = $a.attr('href') || '';
      return /\/threads\/[^/]+\.\d+\/?$/.test(href) || $a.attr('data-tp-primary') === 'on';
    }).first();

    if (!$title.length) {
      // Fallback: first anchor inside .structItem-title
      const $fallback = $el.find('.structItem-title a').first();
      if (!$fallback.length) return;
      registerThread($fallback);
    } else {
      registerThread($title);
    }

    function registerThread($a) {
      const href = $a.attr('href');
      const title = $a.text().trim();
      if (!href || !title) return;
      const url = canonicalThreadUrl(normalizeUrl(href, subforumUrl));
      if (!url) return;
      const id = threadIdFromUrl(url);
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push({
        id,
        url,
        title,
        subforum: subforumName,
        source: 'pinned',
      });
    }
  });

  return out;
}

// --- Thread page parsing (posts + pagination) ---

// Given the HTML of a thread page, return:
//   { title, posts: [...], totalPages, currentPage }
// where each post is { postId, author, dateIso, permalink, bodyHtml, bodyMd }.
export function parseThreadPage(html, threadUrl) {
  const $ = cheerio.load(html);

  const title = $('h1.p-title-value').first().text().trim() || $('title').first().text().trim();
  const totalPages = detectTotalPages($, threadUrl);
  const currentPage = detectCurrentPage($, threadUrl);

  const posts = [];
  $('article.message--post').each((_, el) => {
    try {
      const post = parsePost($, $(el), threadUrl);
      if (post) posts.push(post);
    } catch (err) {
      // A single malformed post (Turndown choke, missing DOM ref) should not
      // kill the whole thread. Skip it and continue.
      // Don't import logger here — keep xenforo.js pure parsing module.
      // The thread will still be marked extracted with however-many posts parsed.
    }
  });

  return { title, posts, totalPages, currentPage };
}

function parsePost($, $msg, threadUrl) {
  // postId — `data-content="post-NNNNN"` or id="js-post-NNNNN"
  const dataContent = $msg.attr('data-content') || '';
  const idAttr = $msg.attr('id') || '';
  let postId = null;
  const mDC = dataContent.match(/post-(\d+)/);
  const mID = idAttr.match(/post-(\d+)/);
  if (mDC) postId = Number(mDC[1]);
  else if (mID) postId = Number(mID[1]);
  if (!postId) return null;

  // author — .message-name a.username text, fall back to .username
  const $authorA = $msg.find('.message-userDetails .message-name a').first();
  const author = ($authorA.text() || $msg.find('.username').first().text() || 'Unknown').trim();

  // date — first <time> inside the post with `datetime` attribute
  const $time = $msg.find('time[datetime]').first();
  const dateIso = ($time.attr('datetime') || '').trim() || null;

  // permalink — XenForo wraps the post date in an <a> pointing to
  // /threads/<slug>.<id>/post-<postId>. Find the first such anchor inside
  // .message-attribution-main, OR fall back to building one ourselves from
  // the threadUrl + postId (XenForo accepts both /post-N and #post-N).
  let permalink = null;
  $msg.find('.message-attribution-main a[href]').each((_, a) => {
    const href = $(a).attr('href');
    if (href && /\/post-\d+/.test(href)) {
      permalink = normalizeUrl(href, threadUrl);
      return false; // break
    }
  });
  if (!permalink) {
    permalink = canonicalThreadUrl(threadUrl).replace(/\/$/, '') + `/post-${postId}`;
  }

  // body HTML — first .bbWrapper inside the message body
  const $body = $msg.find('.message-body .bbWrapper').first();
  if (!$body.length) {
    // Some XenForo themes use .message-userContent .bbWrapper as fallback
    const $alt = $msg.find('.message-userContent .bbWrapper').first();
    if (!$alt.length) return null;
    return finishPost($, $alt, { postId, author, dateIso, permalink });
  }
  return finishPost($, $body, { postId, author, dateIso, permalink });
}

function finishPost($, $body, meta) {
  // Strip ONLY the XenForo "Click to expand..." trigger button and the
  // "shrink" toggle — NOT the outer blockquote (which carries .js-expandWatch
  // on expandable quotes). Removing the blockquote itself was wiping every
  // quoted reply from the output.
  $body.find('.bbCodeBlock-expandLink').remove();
  $body.find('.bbCodeBlock-shrinkLink').remove();
  $body.find('.bbCodeBlock-expandContent .js-expandLink').remove();

  const bodyHtml = $.html($body);
  let bodyMd = turndown.turndown(bodyHtml).trim();
  // Order matters: strip trailing whitespace BEFORE collapsing multi-newlines.
  // XenForo bbcode renders paragraph breaks as repeated <br/> which Turndown
  // converts to `"  \n"` (markdown line-break). Stripping the spaces first
  // exposes the actual newlines so /\n{3,}/ can collapse them.
  bodyMd = bodyMd
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');

  return {
    postId: meta.postId,
    author: meta.author,
    dateIso: meta.dateIso,
    permalink: meta.permalink,
    bodyMd,
  };
}

function detectTotalPages($, threadUrl) {
  // Best signal: .pageNav-jump--last [href=".../page-N"]
  const $last = $('.pageNav-jump--last').first();
  if ($last.length) {
    const href = $last.attr('href') || '';
    const m = href.match(/\/page-(\d+)/);
    if (m) return Number(m[1]);
  }
  // Fallback: max .pageNav-page text
  let maxN = 1;
  $('.pageNav-page').each((_, a) => {
    const t = ($(a).text() || '').trim();
    const n = Number(t);
    if (Number.isFinite(n) && n > maxN) maxN = n;
  });
  // Some XenForo navs expose data-last-page on the wrapper
  const $nav = $('.pageNav').first();
  if ($nav.length) {
    const dl = $nav.attr('data-last-page');
    if (dl) {
      const n = Number(dl);
      if (Number.isFinite(n) && n > maxN) maxN = n;
    }
  }
  return maxN;
}

function detectCurrentPage($, threadUrl) {
  const $cur = $('.pageNav-page--current').first();
  if ($cur.length) {
    const t = ($cur.text() || '').trim();
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  // No pagination = page 1
  return 1;
}

// Build the URL for page N of a thread. Page 1 = canonical thread URL.
export function threadPageUrl(threadUrl, n) {
  const canonical = canonicalThreadUrl(threadUrl);
  if (n === 1) return canonical;
  return canonical.replace(/\/$/, '') + `/page-${n}`;
}
