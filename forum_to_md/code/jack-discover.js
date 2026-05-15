// Jack-contributed discovery.
//
// Walks XenForo search-session results (constrained to user_id=Jack Kruse),
// chains sessions backward in time via c[older_than] until reaching Jack's
// join date or until a session yields zero new thread ids. Merges results
// into threads.json: existing entries (pinned) gain `'jack-contributed'` in
// their `sources` array; new entries are appended.
//
// Hard facts about jackkruse.com search:
// - POST /search/search returns JSON { redirect: "/search/<id>/" }
// - Search session paginates via /search/<id>/page-N (path style)
// - Session is bound to original constraints — pagination just walks deeper
// - Per-page result count = ~20
// - There is NO hard 10-page cap on this instance; sessions paginate freely
//
// Robust break: stop when 3 consecutive pages add 0 new ids (covers result
// pages that don't parse correctly + truly-exhausted sessions).

import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import {
  FORUM_BASE_URL,
  XENFORO_COOKIE,
  USER_AGENT,
  REQUEST_DELAY_MS,
  REQUEST_TIMEOUT_MS,
  JACK_MEMBER_ID,
} from '../settings.js';
import { info, warn, error, section, debug } from './logger.js';
import { startProgressLog, stopProgressLog } from './progress-log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const THREADS_JSON_PATH = path.join(PROJECT_ROOT, 'threads.json');

const JACK_USERNAME = 'Jack Kruse';
const JACK_JOIN_ISO = '2012-03-15T00:00:00';
const MAX_PAGES_PER_SESSION = 200;     // safety cap (real ceiling unknown)
const ZERO_PAGE_STREAK_BREAK = 3;      // stop session after N consecutive empty pages
const ALL_KNOWN_STREAK_BREAK = 80;     // less aggressive — Jack can post in known threads many pages deep before hitting new
const PAGE_DELAY_MS = 350;             // between-page courtesy delay
const SESSION_DELAY_MS = 800;          // between-session courtesy delay
const MAX_SESSIONS = 800;              // absolute safety cap

const baseHeaders = {
  'User-Agent': USER_AGENT,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cookie': XENFORO_COOKIE,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- HTTP helpers ---

async function getCsrfToken() {
  const r = await fetch(FORUM_BASE_URL + '/', { headers: baseHeaders });
  if (!r.ok) throw new Error(`Cannot fetch base for csrf: HTTP ${r.status}`);
  const html = await r.text();
  if (html.includes('data-logged-in="false"')) {
    throw new Error('Cookies invalid (data-logged-in=false on base). Refresh XENFORO_COOKIE in settings.js.');
  }
  const m = html.match(/data-csrf="([^"]+)"/);
  if (!m) throw new Error('No data-csrf attribute found on base page.');
  return m[1];
}

async function createSession({ olderThan, nodeId } = {}) {
  const csrf = await getCsrfToken();
  const form = new URLSearchParams();
  form.set('keywords', '');
  form.set('c[users]', JACK_USERNAME);
  form.set('c[child_nodes]', '1');
  if (olderThan) form.set('c[older_than]', olderThan);
  if (nodeId) form.set('c[nodes][0]', String(nodeId));
  form.set('search_type', 'post');
  form.set('_xfToken', csrf);
  form.set('_xfResponseType', 'json');
  const r = await fetch(FORUM_BASE_URL + '/search/search', {
    method: 'POST',
    headers: {
      ...baseHeaders,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: form.toString(),
  });
  if (!r.ok) throw new Error(`POST /search/search HTTP ${r.status}`);
  const j = await r.json();
  if (j.status === 'error') {
    throw new Error(`Search error: ${JSON.stringify(j.errors || j.message || j)}`);
  }
  if (!j.redirect) throw new Error(`No redirect in search response: ${JSON.stringify(j)}`);
  return j.redirect;
}

// Fetch forum index, return list of { nodeId, name } for every leaf subforum.
async function fetchSubforumIds() {
  const r = await fetch(FORUM_BASE_URL + '/', { headers: baseHeaders });
  if (!r.ok) throw new Error(`Cannot fetch forum index: HTTP ${r.status}`);
  const html = await r.text();
  const cheerio = await import('cheerio');
  const $ = cheerio.load(html);
  const out = [];
  $('.node.node--forum').each((_, el) => {
    const $el = $(el);
    const a = $el.find('h3.node-title a').first();
    const href = a.attr('href') || '';
    const name = a.text().trim();
    const m = href.match(/\/forums\/[^/]+?\.(\d+)\/?$/);
    if (m && name) out.push({ nodeId: Number(m[1]), name });
  });
  return out;
}

// Parse one search-result page; return { harvested, oldestDate }.
// harvested = [{ id, url, title, subforum }]
function parseSearchResultPage(html) {
  const $ = cheerio.load(html);
  if (/data-template="login"/.test(html)) {
    throw new Error('LOGIN_REDIRECT');  // sentinel for 403/expired-cookie
  }
  const out = [];
  const dates = [];

  // XenForo search result rows are `li.block-row` (or `.contentRow` on older
  // templates). Iterate every row regardless of class to be defensive.
  $('li.block-row, li.contentRow, .block-row, .contentRow').each((_, el) => {
    const $el = $(el);

    // Thread link — first anchor pointing to /threads/<slug>.<id>/
    let title = null, url = null, id = null;
    $el.find('a[href^="/threads/"]').each((_, a) => {
      const href = $(a).attr('href') || '';
      const m = href.match(/^\/threads\/([^/]+?)\.(\d+)\//);
      if (m && !id) {
        id = Number(m[2]);
        url = new URL(href, FORUM_BASE_URL).toString().split('#')[0];
        const txt = $(a).text().trim();
        if (txt) title = txt;
      }
    });
    if (!id) return;

    // Subforum link — anchor pointing to /forums/<slug>.<id>/
    let subforum = null;
    $el.find('a[href*="/forums/"]').each((_, a) => {
      if (subforum) return;
      const t = $(a).text().trim();
      if (t) subforum = t;
    });

    // Date — first <time datetime="...">
    const dt = $el.find('time[datetime]').first().attr('datetime');
    if (dt) dates.push(dt);

    out.push({ id, url, title, subforum });
  });

  dates.sort();
  return { harvested: out, oldestDate: dates[0] || null, dateCount: dates.length };
}

async function fetchResultPage(sessionUrl, page) {
  // XenForo search uses query-string pagination: /search/<id>/?page=N. Path-
  // style /page-N returns 404 here (that's forum-thread pagination format).
  const url = page === 1 ? sessionUrl : sessionUrl + `?page=${page}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: baseHeaders, signal: controller.signal });
    clearTimeout(t);
    if (r.status === 404) return { html: null, status: 404, errMessage: '404 (end of pagination)' };
    if (!r.ok) return { html: null, status: r.status, errMessage: `HTTP ${r.status}` };
    return { html: await r.text(), status: r.status, errMessage: null };
  } catch (err) {
    clearTimeout(t);
    return { html: null, status: 0, errMessage: err.message };
  }
}

async function walkSession(sessionUrl, knownIds) {
  const newIds = new Set();
  const newMeta = new Map();
  let oldestSeen = null;
  let emptyStreak = 0;             // pages with ZERO results (truly end of pagination)
  let allKnownStreak = 0;          // pages where all results are pre-known (we're walking past discovered territory)
  let page = 1;
  while (page <= MAX_PAGES_PER_SESSION) {
    const { html, status, errMessage } = await fetchResultPage(sessionUrl, page);
    if (!html) {
      if (status === 404) {
        debug(`    page ${page}: HTTP 404 — end of session`);
        break;
      }
      warn(`    page ${page}: ${errMessage}`);
      break;
    }
    let parsed;
    try {
      parsed = parseSearchResultPage(html);
    } catch (err) {
      if (err.message === 'LOGIN_REDIRECT') throw err;
      warn(`    page ${page}: parse error ${err.message}`);
      break;
    }
    const { harvested, oldestDate } = parsed;
    if (harvested.length === 0) {
      // Truly empty result page — pagination exhausted
      emptyStreak++;
      if (emptyStreak >= 2) {
        debug(`    page ${page}: empty result page (streak=${emptyStreak}) — end of session`);
        break;
      }
    } else {
      emptyStreak = 0;
    }
    let pageNew = 0;
    for (const h of harvested) {
      if (knownIds.has(h.id) || newIds.has(h.id)) continue;
      newIds.add(h.id);
      newMeta.set(h.id, h);
      pageNew++;
    }
    if (oldestDate) {
      if (!oldestSeen || oldestDate < oldestSeen) oldestSeen = oldestDate;
    }
    // Walk DEEPER past pages-of-already-known: we still need the date range.
    // But after WALK_LIMIT_ALL_KNOWN consecutive all-known pages we can be
    // confident the session covers fully-discovered territory; bail with the
    // oldest date we've collected so the outer loop slides back.
    if (harvested.length > 0 && pageNew === 0) {
      allKnownStreak++;
      if (allKnownStreak >= ALL_KNOWN_STREAK_BREAK) {
        debug(`    page ${page}: ${ALL_KNOWN_STREAK_BREAK} consecutive all-known pages — bail with oldestSeen=${oldestSeen}`);
        break;
      }
    } else {
      allKnownStreak = 0;
    }
    page++;
    await sleep(PAGE_DELAY_MS);
  }
  return { newIds, newMeta, oldestSeen, pagesWalked: page - 1 };
}

// --- Main ---

export async function runJackDiscover() {
  section('Jack-contributed discover (search-session chain)');
  startProgressLog('jack-discover');

  // Load existing threads.json
  let threads;
  try {
    threads = JSON.parse(await readFile(THREADS_JSON_PATH, 'utf-8'));
  } catch (e) {
    if (e.code === 'ENOENT') threads = [];
    else throw e;
  }
  // Migrate old `source` field to `sources` array (idempotent)
  for (const t of threads) {
    if (!Array.isArray(t.sources)) {
      t.sources = t.source ? [t.source] : ['pinned'];
      delete t.source;
    }
  }

  const knownIds = new Set(threads.map(t => t.id));
  const idToThread = new Map(threads.map(t => [t.id, t]));
  info(`Starting with ${threads.length} known threads (will dedupe)`);

  // Pre-flight: verify cookies work
  try {
    await getCsrfToken();
    info('Cookies OK (data-logged-in=true on base)');
  } catch (e) {
    error(`Pre-flight failed: ${e.message}`);
    process.exit(1);
  }

  let olderThan = null;
  let sessionCount = 0;
  let totalNewThisRun = 0;
  let totalReinforcedThisRun = 0;
  const discoveredAt = new Date().toISOString();
  const t0 = Date.now();

  while (sessionCount < MAX_SESSIONS) {
    sessionCount++;
    let sessionUrl;
    try {
      sessionUrl = await createSession({ olderThan });
    } catch (e) {
      error(`Session ${sessionCount} create failed: ${e.message}`);
      break;
    }

    let result;
    try {
      result = await walkSession(sessionUrl, knownIds);
    } catch (e) {
      if (e.message === 'LOGIN_REDIRECT') {
        warn(`Session ${sessionCount}: cookies expired mid-walk. Saving progress and exiting.`);
        await persistThreads(threads);
        error('Refresh XENFORO_COOKIE in settings.js, then re-run `npm run discover-jack`.');
        process.exit(2);
      }
      error(`Session ${sessionCount} walk failed: ${e.message}`);
      break;
    }

    const { newIds, newMeta, oldestSeen, pagesWalked } = result;

    // For each NEW id, append to threads array. For threads we already knew
    // (e.g. pinned threads Jack also posted in), mark 'jack-contributed' in
    // their sources array.
    let reinforced = 0;
    for (const id of newIds) {
      if (idToThread.has(id)) {
        const t = idToThread.get(id);
        if (!t.sources.includes('jack-contributed')) {
          t.sources.push('jack-contributed');
          reinforced++;
        }
      } else {
        const meta = newMeta.get(id) || {};
        const entry = {
          id,
          url: meta.url,
          title: meta.title || null,
          subforum: meta.subforum || null,
          sources: ['jack-contributed'],
          discovered_at: discoveredAt,
          extracted: false,
        };
        threads.push(entry);
        idToThread.set(id, entry);
        knownIds.add(id);
      }
    }
    // Reinforce knownIds for the search-walk's dedup (already handled above)
    totalNewThisRun += newIds.size - reinforced;
    totalReinforcedThisRun += reinforced;

    const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
    info(`  session ${sessionCount}: ${pagesWalked}p, +${newIds.size - reinforced} new, ${reinforced} reinforced pinned, oldest=${oldestSeen || 'n/a'}, total-known=${knownIds.size}, elapsed=${elapsedSec}s`);

    // Persist progress every 10 sessions
    if (sessionCount % 10 === 0) {
      await persistThreads(threads);
    }

    // Termination
    if (!oldestSeen) {
      info('No oldest date in last session — ending');
      break;
    }
    if (oldestSeen < JACK_JOIN_ISO) {
      info(`Reached Jack join date (oldest=${oldestSeen} < ${JACK_JOIN_ISO}) — ending`);
      break;
    }
    if (olderThan === oldestSeen) {
      warn(`Date filter not advancing (stuck at ${oldestSeen}) — ending`);
      break;
    }
    // Note: don't break on `newIds.size === 0` — we may be walking through a
    // region of already-discovered threads; keep sliding back via older_than.
    olderThan = oldestSeen;
    await sleep(SESSION_DELAY_MS);
  }

  await persistThreads(threads);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  info(`-> Phase 1 (date-chain): ${sessionCount} sessions, +${totalNewThisRun} new threads, +${totalReinforcedThisRun} reinforced pinned, ${dt}s elapsed`);

  // === Phase 2 — per-subforum jack search ===
  // Different search slice than date-chain. Catches threads missed when Jack
  // burst-posted in many known threads consecutively (date-chain bailed early).
  section('Phase 2 — per-subforum jack search');
  let subforums;
  try {
    subforums = await fetchSubforumIds();
    info(`Walking ${subforums.length} subforums constrained to user=Jack Kruse`);
  } catch (e) {
    warn(`Phase 2 skipped: ${e.message}`);
    return;
  }
  let phase2New = 0;
  let phase2Sessions = 0;
  const t2 = Date.now();
  for (const sf of subforums) {
    phase2Sessions++;
    let url;
    try {
      url = await createSession({ nodeId: sf.nodeId });
    } catch (e) {
      warn(`  ${sf.name} (node ${sf.nodeId}) session create failed: ${e.message}`);
      continue;
    }
    let result;
    try {
      result = await walkSession(url, knownIds);
    } catch (e) {
      if (e.message === 'LOGIN_REDIRECT') {
        warn(`Phase 2: cookies expired in ${sf.name}. Saving progress.`);
        await persistThreads(threads);
        error('Refresh XENFORO_COOKIE in settings.js, then re-run.');
        process.exit(2);
      }
      warn(`  ${sf.name}: walk failed ${e.message}`);
      continue;
    }
    const { newIds, newMeta, pagesWalked } = result;
    let added = 0;
    for (const id of newIds) {
      if (idToThread.has(id)) {
        const t = idToThread.get(id);
        if (!t.sources.includes('jack-contributed')) {
          t.sources.push('jack-contributed');
        }
      } else {
        const meta = newMeta.get(id) || {};
        const entry = {
          id,
          url: meta.url,
          title: meta.title || null,
          subforum: meta.subforum || sf.name,
          sources: ['jack-contributed'],
          discovered_at: discoveredAt,
          extracted: false,
        };
        threads.push(entry);
        idToThread.set(id, entry);
        knownIds.add(id);
        added++;
      }
    }
    phase2New += added;
    const elapsed = ((Date.now() - t2) / 1000).toFixed(1);
    info(`  [${phase2Sessions}/${subforums.length}] ${sf.name}: ${pagesWalked}p, +${added} new (subforum walk), elapsed=${elapsed}s`);
    await persistThreads(threads);
    await sleep(SESSION_DELAY_MS);
  }
  await persistThreads(threads);
  const dt2 = ((Date.now() - t2) / 1000).toFixed(1);
  info(`-> Phase 2 (per-subforum): ${phase2Sessions} sessions, +${phase2New} new threads, ${dt2}s elapsed`);
  info(`-> threads.json now has ${threads.length} entries`);
  await stopProgressLog('END', { totalSessions: sessionCount + phase2Sessions, phase1New: totalNewThisRun, phase2New });
}

async function persistThreads(localThreads) {
  // Merge with file (which may have extract's extracted=true updates).
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
    if (!local) {
      merged.push(f);
      continue;
    }
    const unionSources = Array.from(new Set([...(f.sources || []), ...(local.sources || [])]));
    merged.push({
      ...local,
      ...f,                            // file fields override (extract's extracted=true wins)
      sources: unionSources,
      title: local.title || f.title,
      subforum: local.subforum || f.subforum,
    });
  }
  // New threads discover found that file doesn't have
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
