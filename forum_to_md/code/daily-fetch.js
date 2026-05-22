// Fetch the /find-new/posts/ page on XenForo and parse out recent posts.
// Returns a flat list of post records (one per post entry on the page).
//
// XenForo's "What's New" / "Find new posts" lists the most recent posts
// across all visible forums. Each entry typically contains:
//   - thread title + URL
//   - latest post author + URL + timestamp (as a <time data-time="unix">)
//   - a snippet of the latest post body
//   - the containing forum name
//
// We pull as much as we can. Pagination is capped to keep daily run small.

import * as cheerio from 'cheerio';
import { FORUM_BASE_URL, USER_AGENT, REQUEST_TIMEOUT_MS } from '../settings.js';
import { info, warn } from './logger.js';

const MAX_PAGES = 3;        // cap pagination — daily volume rarely exceeds page 1
const WINDOW_HOURS = 24;    // only keep posts from the last N hours
const POST_BODY_CHAR_CAP = 600;   // truncate post body in the JSON to save tokens
const FETCH_DELAY_MS = 800;       // polite delay between thread fetches

function timeoutFetch(url, init) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  return fetch(url, { ...init, signal: ctl.signal }).finally(() => clearTimeout(t));
}

async function fetchPage(url, cookieString) {
  const res = await timeoutFetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: cookieString,
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`fetch ${url} HTTP ${res.status}`);
  return res.text();
}

// Parse a XenForo /find-new/posts/ HTML page into post records.
// XenForo 2.x list markup uses `.structItem--thread` rows for thread-grouped
// listings. Each row carries title, latest poster, latest date.
function parsePostsPage(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('.structItem--thread, .structItem--post').each((_, el) => {
    const $el = $(el);
    const titleA = $el.find('.structItem-title a').first();
    const thread_title = titleA.text().trim();
    const thread_url_rel = titleA.attr('href') || '';
    const thread_url = thread_url_rel.startsWith('http')
      ? thread_url_rel
      : FORUM_BASE_URL + thread_url_rel;

    // Latest post block — has author + time.
    const latest = $el.find('.structItem-cell--latest').first();
    const author = latest.find('.username').first().text().trim()
      || $el.find('.structItem-minor .username').first().text().trim();
    const $time = latest.find('time').first().length
      ? latest.find('time').first()
      : $el.find('time').first();
    const ts = $time.attr('data-time');
    const posted_at = ts ? new Date(Number(ts) * 1000).toISOString() : null;
    const post_url_rel = latest.find('a').first().attr('href') || '';
    const post_url = post_url_rel.startsWith('http') ? post_url_rel
      : (post_url_rel ? FORUM_BASE_URL + post_url_rel : thread_url);

    // Forum / category — appears in micro-text under title.
    const forum_name = $el.find('.structItem-parts li').first().text().trim()
      || $el.find('.structItem-cell--main .structItem-parts').first().text().trim()
      || null;

    if (thread_title && thread_url) {
      out.push({
        thread_title,
        thread_url,
        post_url,
        author: author || null,
        posted_at,
        forum_name,
      });
    }
  });
  return out;
}

function parseNextPageLink($) {
  const next = $('a.pageNav-jump--next').first().attr('href');
  if (!next) return null;
  return next.startsWith('http') ? next : FORUM_BASE_URL + next;
}

// Fetch a single thread's "latest" URL and extract the latest post body.
// XenForo redirects /threads/<slug>.<id>/latest to the thread page anchored
// on the newest post. We pull all `.message--post .bbWrapper` blocks on that
// page and pick the last one (newest visible on the page).
async function fetchLatestPostBody(threadLatestUrl, cookieString) {
  try {
    const html = await fetchPage(threadLatestUrl, cookieString);
    const $ = cheerio.load(html);
    const wrappers = $('article.message--post .bbWrapper');
    if (!wrappers.length) return null;
    // Last wrapper on page = latest post (XenForo ascending order by default).
    const last = wrappers.last();
    // Drop nested quote blocks so the AI sees only the post author's words.
    last.find('blockquote').remove();
    const text = last.text().replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return text.length > POST_BODY_CHAR_CAP
      ? text.slice(0, POST_BODY_CHAR_CAP).trim() + '…'
      : text;
  } catch (e) {
    warn(`fetchLatestPostBody failed ${threadLatestUrl}: ${e.message}`);
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fetch up to MAX_PAGES of /find-new/posts, filter to last WINDOW_HOURS,
// dedup by post_url. Returns sorted-newest-first array.
export async function fetchRecentPosts(cookieString, { maxPages = MAX_PAGES, windowHours = WINDOW_HOURS } = {}) {
  const cutoff = Date.now() - windowHours * 60 * 60 * 1000;
  const seen = new Set();
  const all = [];
  let url = `${FORUM_BASE_URL}/find-new/posts/`;
  for (let page = 1; page <= maxPages && url; page++) {
    info(`forum-daily: fetching page ${page} ${url}`);
    const html = await fetchPage(url, cookieString);
    if (/data-template="login"/.test(html) && /data-logged-in="false"/.test(html)) {
      throw new Error('forum-daily: login-redirect detected — cookies invalid');
    }
    const $ = cheerio.load(html);
    const posts = parsePostsPage(html);
    let oldOnPage = 0;
    for (const p of posts) {
      if (!p.posted_at) continue;
      if (seen.has(p.post_url)) continue;
      const ts = new Date(p.posted_at).getTime();
      if (ts < cutoff) { oldOnPage++; continue; }
      seen.add(p.post_url);
      all.push(p);
    }
    // If every post on this page is older than our window, no point paginating.
    if (posts.length && oldOnPage === posts.length) {
      info(`forum-daily: page ${page} all older than ${windowHours}h — stopping`);
      break;
    }
    url = parseNextPageLink($);
  }
  all.sort((a, b) => new Date(b.posted_at) - new Date(a.posted_at));
  info(`forum-daily: ${all.length} post(s) in last ${windowHours}h — fetching bodies...`);

  // Hydrate each entry with the latest post body so the AI summarizer has
  // actual content to work with (the listing page only carries metadata).
  for (let i = 0; i < all.length; i++) {
    const p = all[i];
    const url = p.thread_url || p.post_url;
    p.content = await fetchLatestPostBody(url, cookieString);
    info(`forum-daily: [${i + 1}/${all.length}] ${p.content ? `+${p.content.length} chars` : 'no body'} — ${p.thread_title.slice(0, 60)}`);
    if (i < all.length - 1) await sleep(FETCH_DELAY_MS);
  }

  return all;
}
