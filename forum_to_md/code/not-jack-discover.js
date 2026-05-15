// Not-Jack discovery.
//
// Walks every subforum's complete thread-list pagination, harvests every
// thread URL not already in threads.json, adds them with the provisional
// source tag 'discovered-via-subforum'. After extract runs, split classifies
// threads as 'jack' vs 'not-jack' purely by whether jack_post_count > 0 in
// the per-thread MD.
//
// Cost: 30 subforums × maybe 30 pages avg × ~1.5s = ~22 min for discovery.
// Then extract: maybe 10-20k new threads × ~1-2 pages avg × CONCURRENCY 3 =
// many hours.

import { readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import {
  FORUM_BASE_URL,
  XENFORO_COOKIE,
  USER_AGENT,
  REQUEST_DELAY_MS,
  REQUEST_TIMEOUT_MS,
} from '../settings.js';
import { canonicalThreadUrl, threadIdFromUrl, normalizeUrl } from './url-utils.js';
import { info, warn, error, section, debug } from './logger.js';
import { startProgressLog, stopProgressLog } from './progress-log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const THREADS_JSON_PATH = path.join(PROJECT_ROOT, 'threads.json');

const PAGE_DELAY_MS = 350;
const MAX_PAGES_PER_SUBFORUM = 1000;

const headers = {
  'User-Agent': USER_AGENT,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cookie': XENFORO_COOKIE,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOk(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(t);
    if (!r.ok) return { html: null, status: r.status, errMessage: `HTTP ${r.status}` };
    const html = await r.text();
    if (/data-template="login"/.test(html) && /data-logged-in="false"/.test(html)) {
      return { html: null, status: r.status, errMessage: 'LOGIN_REDIRECT' };
    }
    return { html, status: r.status, errMessage: null };
  } catch (e) {
    clearTimeout(t);
    return { html: null, status: 0, errMessage: e.message };
  } finally {
    clearTimeout(t);
  }
}

function parseSubforumIndex(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('.node.node--forum').each((_, el) => {
    const $el = $(el);
    const a = $el.find('h3.node-title a').first();
    const href = a.attr('href') || '';
    const name = a.text().trim();
    const url = normalizeUrl(href, FORUM_BASE_URL);
    if (!url || !name) return;
    out.push({ url, name });
  });
  return out;
}

// Parse a subforum thread-list page. Returns { harvested: [{id,url,title}], lastPage }.
function parseSubforumPage(html, subforumUrl, subforumName) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('.structItem.structItem--thread').each((_, el) => {
    const $el = $(el);
    const $a = $el.find('.structItem-title a').filter((_, a) => {
      const href = $(a).attr('href') || '';
      return /\/threads\/[^/]+\.\d+\/?$/.test(href) || $(a).attr('data-tp-primary') === 'on';
    }).first();
    const $title = $a.length ? $a : $el.find('.structItem-title a').first();
    if (!$title.length) return;
    const href = $title.attr('href');
    const title = $title.text().trim();
    if (!href || !title) return;
    const url = canonicalThreadUrl(normalizeUrl(href, subforumUrl));
    const id = threadIdFromUrl(url);
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, url, title, subforum: subforumName });
  });
  // Detect last page from pageNav-jump--last
  let lastPage = 1;
  const $lastLink = $('.pageNav-jump--last').first();
  if ($lastLink.length) {
    const href = $lastLink.attr('href') || '';
    const m = href.match(/\/page-(\d+)/);
    if (m) lastPage = Number(m[1]);
  } else {
    // Fallback: max .pageNav-page number
    $('.pageNav-page').each((_, a) => {
      const n = Number(($(a).text() || '').trim());
      if (Number.isFinite(n) && n > lastPage) lastPage = n;
    });
  }
  return { harvested: out, lastPage };
}

function pageNUrl(subforumUrl, n) {
  if (n === 1) return subforumUrl;
  return subforumUrl.replace(/\/$/, '') + `/page-${n}`;
}

async function persistThreads(localThreads) {
  // Merge-on-persist (same pattern as jack-discover)
  let current;
  try {
    current = JSON.parse(await readFile(THREADS_JSON_PATH, 'utf-8'));
  } catch {
    current = [];
  }
  const localById = new Map(localThreads.map((t) => [t.id, t]));
  const merged = [];
  const seen = new Set();
  for (const f of current) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    const local = localById.get(f.id);
    if (!local) { merged.push(f); continue; }
    const unionSources = Array.from(new Set([...(f.sources || []), ...(local.sources || [])]));
    merged.push({ ...local, ...f, sources: unionSources, title: local.title || f.title, subforum: local.subforum || f.subforum });
  }
  for (const l of localThreads) {
    if (!seen.has(l.id)) merged.push(l);
  }
  merged.sort((a, b) => (a.id || 0) - (b.id || 0));
  const tmp = `${THREADS_JSON_PATH}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rename(tmp, THREADS_JSON_PATH);
      return;
    } catch (e) {
      if (e.code !== 'EPERM' && e.code !== 'EBUSY') throw e;
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 200));
    }
  }
  warn(`persistThreads: rename gave up after 10 retries`);
}

export async function runNotJackDiscover({ subforumIds = null } = {}) {
  section(`Not-Jack discover (subforum exhaustive walk${subforumIds ? `, filter=${subforumIds.join(',')}` : ', all subforums'})`);
  startProgressLog(`not-jack-discover${subforumIds ? `:${subforumIds.join(',')}` : ''}`);

  // Pre-flight: check cookies
  const probe = await fetchOk(FORUM_BASE_URL + '/');
  if (!probe.html) {
    error(`Pre-flight failed: ${probe.errMessage}`);
    process.exit(1);
  }
  info('Cookies OK');

  // Subforum list, optionally filtered to a specific subset
  let subforums = parseSubforumIndex(probe.html);
  if (subforumIds) {
    const wanted = new Set(subforumIds.map(String));
    subforums = subforums.filter((sf) => {
      const m = sf.url.match(/\/forums\/[^/]+?\.(\d+)\/?$/);
      return m && wanted.has(m[1]);
    });
  }
  info(`Walking ${subforums.length} subforums`);

  // Load threads.json
  let threads = [];
  if (existsSync(THREADS_JSON_PATH)) {
    threads = JSON.parse(await readFile(THREADS_JSON_PATH, 'utf-8'));
  }
  const knownIds = new Set(threads.map((t) => t.id));
  info(`Starting with ${threads.length} known thread ids (will dedupe)`);

  const discoveredAt = new Date().toISOString();
  const t0 = Date.now();
  let totalNew = 0;
  let totalSubforums = 0;

  for (const sf of subforums) {
    totalSubforums++;
    info(`[${totalSubforums}/${subforums.length}] ${sf.name}`);
    let lastPage = 1;
    // First page tells us total pages
    const p1 = await fetchOk(pageNUrl(sf.url, 1));
    await sleep(PAGE_DELAY_MS);
    if (!p1.html) {
      if (p1.errMessage === 'LOGIN_REDIRECT') {
        warn(`  cookies expired in ${sf.name}. Saving progress and exiting.`);
        await persistThreads(threads);
        error('Refresh XENFORO_COOKIE in settings.js, then re-run.');
        process.exit(2);
      }
      warn(`  p1 fail: ${p1.errMessage}`);
      continue;
    }
    const parsed1 = parseSubforumPage(p1.html, sf.url, sf.name);
    lastPage = Math.min(parsed1.lastPage, MAX_PAGES_PER_SUBFORUM);
    info(`  ${parsed1.harvested.length} threads on p1, ${lastPage} total pages`);
    let subforumNew = 0;
    for (const h of parsed1.harvested) {
      if (knownIds.has(h.id)) continue;
      knownIds.add(h.id);
      threads.push({
        id: h.id,
        url: h.url,
        title: h.title,
        subforum: h.subforum,
        sources: ['discovered-via-subforum'],
        discovered_at: discoveredAt,
        extracted: false,
      });
      subforumNew++;
    }
    // Walk remaining pages
    for (let p = 2; p <= lastPage; p++) {
      const rN = await fetchOk(pageNUrl(sf.url, p));
      await sleep(PAGE_DELAY_MS);
      if (!rN.html) {
        if (rN.errMessage === 'LOGIN_REDIRECT') {
          warn(`  cookies expired at ${sf.name} p${p}. Saving and exiting.`);
          await persistThreads(threads);
          error('Refresh XENFORO_COOKIE in settings.js, then re-run.');
          process.exit(2);
        }
        warn(`  ${sf.name} p${p}: ${rN.errMessage} — skipping rest`);
        break;
      }
      const parsedN = parseSubforumPage(rN.html, sf.url, sf.name);
      for (const h of parsedN.harvested) {
        if (knownIds.has(h.id)) continue;
        knownIds.add(h.id);
        threads.push({
          id: h.id,
          url: h.url,
          title: h.title,
          subforum: h.subforum,
          sources: ['discovered-via-subforum'],
          discovered_at: discoveredAt,
          extracted: false,
        });
        subforumNew++;
      }
      if (p % 10 === 0) {
        debug(`    p${p}/${lastPage}, +${subforumNew} new so far`);
      }
    }
    totalNew += subforumNew;
    info(`  ${sf.name}: +${subforumNew} new threads, total known=${knownIds.size}`);
    await persistThreads(threads);
  }

  await persistThreads(threads);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  info(`-> ${totalSubforums} subforums walked, +${totalNew} new threads, ${dt}s elapsed`);
  info(`-> threads.json now has ${threads.length} entries`);
  await stopProgressLog('END', { subforumsWalked: totalSubforums, newThreads: totalNew });
}
