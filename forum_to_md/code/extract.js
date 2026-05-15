// Stage 2 — Extract.
//
// Per-thread output. Reads threads.json, processes only entries where
// `extracted !== true`, writes one MD file per thread to
// `processed_mds/threads/<id>.md`, then marks threads.json `extracted: true`.
//
// Resumable: a run that's interrupted (cookie expiry, network blip, user
// Ctrl-C) can be resumed by simply running `npm run extract` again — already-
// extracted threads are skipped.
//
// Cookie-expiry handling: on detected login-redirect or HTTP 403, the run
// stops gracefully (persists threads.json), prints the refresh procedure,
// and exits with code 2.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pLimit from 'p-limit';
import {
  CONCURRENCY,
  REQUEST_DELAY_MS,
  MIN_POST_BODY_CHARS,
  MAX_THREAD_PAGES,
  THREAD_SEPARATOR,
} from '../settings.js';
import { fetchHtml } from './http.js';
import { parseThreadPage, threadPageUrl } from './xenforo.js';
import { threadFilenameStem, canonicalThreadUrl } from './url-utils.js';
import { startProgressLog, stopProgressLog, writeProgressRow, bumpWorker } from './progress-log.js';
import { info, warn, error, section } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const THREADS_JSON_PATH = path.join(PROJECT_ROOT, 'threads.json');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'processed_mds');
const THREADS_DIR = path.join(OUTPUT_DIR, 'threads');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CookiesExpiredError extends Error {
  constructor(where) {
    super(`Cookies expired at ${where}. Refresh XENFORO_COOKIE in settings.js, then re-run npm run extract (already-done threads will be skipped).`);
    this.name = 'CookiesExpiredError';
  }
}

export async function runExtract({ limit = null, shard = null } = {}) {
  section('Extract stage');
  const shardLabel = shard ? `extract-shard-${shard.index}of${shard.total}` : 'extract';
  startProgressLog(shardLabel);

  if (!existsSync(THREADS_JSON_PATH)) {
    error(`threads.json not found at ${THREADS_JSON_PATH}. Run discover stage first.`);
    process.exit(1);
  }

  const allThreads = JSON.parse(await readFile(THREADS_JSON_PATH, 'utf-8'));
  if (!Array.isArray(allThreads) || allThreads.length === 0) {
    error('threads.json is empty or malformed.');
    process.exit(1);
  }
  // Migrate stragglers (defensive)
  for (const t of allThreads) {
    if (!Array.isArray(t.sources)) {
      t.sources = t.source ? [t.source] : ['pinned'];
      delete t.source;
    }
    if (t.extracted === undefined) t.extracted = false;
  }

  let pending = allThreads.filter((t) => !t.extracted);
  // Process newest threads first (descending by id). Higher XenForo thread id = more recent.
  pending.sort((a, b) => (b.id || 0) - (a.id || 0));
  if (shard && shard.total > 1) {
    // Shard by position-in-sorted-list (not id%mod, which can be skewed for
    // narrow id ranges). Each shard gets approximately equal pending count.
    pending = pending.filter((_, idx) => (idx % shard.total) === shard.index);
    info(`Sharded: processing every ${shard.total}th pending offset ${shard.index} (${pending.length} threads in this shard, newest first)`);
  }
  if (limit && Number.isFinite(limit) && limit > 0 && limit < pending.length) {
    info(`Limiting extract to first ${limit} pending threads (smoke-test mode)`);
    pending = pending.slice(0, limit);
  }
  info(`threads.json: ${allThreads.length} total, ${pending.length} pending extract${shard ? ' (shard)' : ''}, ${allThreads.length - pending.length} already done overall`);
  if (pending.length === 0) {
    info('Nothing to extract. All threads marked extracted=true.');
    await stopProgressLog('END', { reason: 'nothing-pending' });
    return;
  }

  await mkdir(THREADS_DIR, { recursive: true });

  const concurrencyLimit = pLimit(CONCURRENCY);
  const runId = `extract-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const t0 = Date.now();
  let done = 0;
  let totalPosts = 0;
  let totalPages = 0;
  let failed = 0;
  let cookiesExpired = false;
  let lastError = null;

  // Persist every PERSIST_INTERVAL successful threads
  const PERSIST_INTERVAL = 10;
  let unpersistedCount = 0;

  await Promise.all(pending.map((thread) => concurrencyLimit(async () => {
    if (cookiesExpired) return null;  // short-circuit remaining after expiry
    done++;
    const prefix = `[${done}/${pending.length}]`;
    try {
      const r = await fetchThread(thread);
      const threadMd = renderThreadFile({ thread, ...r });
      const stem = threadFilenameStem(thread.url) || `thread.${thread.id}`;
      const outPath = path.join(THREADS_DIR, `${stem}.md`);
      await writeFile(outPath, threadMd, 'utf-8');
      // Update in-memory thread entry
      thread.extracted = true;
      thread.extracted_at = new Date().toISOString();
      thread.extracted_run_id = runId;
      thread.extracted_post_count = r.posts.length;
      thread.extracted_pages = r.pagesFetched;
      if (r.title && !thread.title) thread.title = r.title;
      totalPosts += r.posts.length;
      totalPages += r.pagesFetched;
      unpersistedCount++;
      bumpWorker({ threadsDone: 1, postsExtracted: r.posts.length, pagesFetched: r.pagesFetched });
      info(`${prefix} ok    ${r.posts.length} posts / ${r.pagesFetched} pages — ${(thread.title || '?').slice(0, 60)}`);
      if (unpersistedCount >= PERSIST_INTERVAL) {
        await persistThreads(allThreads);
        unpersistedCount = 0;
      }
    } catch (err) {
      if (err instanceof CookiesExpiredError) {
        cookiesExpired = true;
        lastError = err;
        return null;
      }
      // EPERM/EBUSY on rename is a Windows race quirk — the actual MD file
      // was already written and the in-memory thread.extracted=true. Next
      // persist cycle catches up.
      if (err.code === 'EPERM' || err.code === 'EBUSY') {
        warn(`${prefix} persist-race ${thread.url} — MD saved, metadata catches up next cycle`);
        return null;
      }
      failed++;
      bumpWorker({ failed: 1 });
      warn(`${prefix} FAIL  ${thread.url} — ${err.message}`);
    }
  })));

  // Final persist (always)
  await persistThreads(allThreads);

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const okCount = pending.filter((t) => t.extracted).length;
  info(`-> threads ok=${okCount} failed=${failed} posts=${totalPosts} pages=${totalPages} elapsed=${dt}s`);
  info(`   per-thread MDs in: ${path.relative(PROJECT_ROOT, THREADS_DIR)}`);

  if (cookiesExpired) {
    error('');
    error('================ COOKIES EXPIRED ================');
    error(lastError.message);
    error('After refreshing cookies, run `npm run extract` to resume.');
    error('=================================================');
    await stopProgressLog('COOKIES_EXPIRED', { reason: lastError.message });
    process.exit(2);
  }
  await stopProgressLog('END', { okCount: okCount, failed: failed, posts: totalPosts });
}

// Fetch a thread across all its pages. Returns { posts, pagesFetched, title }.
async function fetchThread(thread) {
  const page1Url = threadPageUrl(thread.url, 1);
  const r1 = await fetchHtml(page1Url);
  await sleep(REQUEST_DELAY_MS);
  // Real cookie expiry: html present, login template detected by http.js.
  if (r1.loginRedirect) throw new CookiesExpiredError(`thread ${thread.id} page 1`);
  // HTTP 403 without login-redirect = thread is gated (Inner Circle / members
  // only / deleted). NOT a cookie issue. Skip the thread, do not abort run.
  if (!r1.html) throw new Error(`page 1: ${r1.errMessage}`);

  const parsed1 = parseThreadPage(r1.html, thread.url);
  const totalPages = Math.min(parsed1.totalPages || 1, MAX_THREAD_PAGES);
  if (parsed1.totalPages > MAX_THREAD_PAGES) {
    warn(`thread ${thread.id} reports ${parsed1.totalPages} pages — capped at ${MAX_THREAD_PAGES}`);
  }

  const seenPostIds = new Set();
  const posts = [];
  for (const p of parsed1.posts) {
    if (seenPostIds.has(p.postId)) continue;
    if (p.bodyMd.length < MIN_POST_BODY_CHARS) continue;
    seenPostIds.add(p.postId);
    posts.push(p);
  }

  let pagesFetched = 1;
  for (let n = 2; n <= totalPages; n++) {
    const pageUrl = threadPageUrl(thread.url, n);
    const rN = await fetchHtml(pageUrl);
    await sleep(REQUEST_DELAY_MS);
    if (rN.loginRedirect) throw new CookiesExpiredError(`thread ${thread.id} page ${n}`);
    if (!rN.html) {
      warn(`thread ${thread.id} page ${n}: ${rN.errMessage} — skipping rest of pages`);
      break;
    }
    pagesFetched++;
    const parsedN = parseThreadPage(rN.html, thread.url);
    for (const p of parsedN.posts) {
      if (seenPostIds.has(p.postId)) continue;
      if (p.bodyMd.length < MIN_POST_BODY_CHARS) continue;
      seenPostIds.add(p.postId);
      posts.push(p);
    }
  }

  posts.sort((a, b) => {
    if (a.dateIso && b.dateIso) return a.dateIso.localeCompare(b.dateIso);
    return a.postId - b.postId;
  });

  return { posts, pagesFetched, title: parsed1.title };
}

// --- Rendering ---

function renderThreadFile({ thread, posts, title }) {
  const displayTitle = title || thread.title || `Thread ${thread.id}`;
  const head = [
    THREAD_SEPARATOR,
    `# Thread: ${displayTitle}`,
    `**Thread URL:** <${canonicalThreadUrl(thread.url)}>`,
    `**Subforum:** ${thread.subforum || '(unknown)'}`,
    `**Posts:** ${posts.length}`,
    THREAD_SEPARATOR,
    '',
  ].join('\n');
  const body = posts.map(renderPost).join('\n');
  return head + body + '\n';
}

function renderPost(post) {
  const dateLabel = post.dateIso || 'unknown date';
  return [
    `### ${post.author} — ${dateLabel}`,
    `**Source:** <${post.permalink}>`,
    '',
    post.bodyMd,
    '',
  ].join('\n');
}

// --- Atomic threads.json persistence with merge for parallel discover ---
// Re-reads the current file before write and merges: discover may have added
// new threads (or updated existing pinned entries to include 'jack-contributed'
// in sources). Extract may have marked threads extracted=true. Both must survive.

async function persistThreads(localThreads) {
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
    // Local extract knows extracted-state. File may carry newer sources/title
    // from a parallel discover. Take local's extracted-* fields; take file's
    // sources (union) + non-extract fields.
    const unionSources = Array.from(new Set([...(f.sources || []), ...(local.sources || [])]));
    merged.push({
      ...f,
      ...local,
      sources: unionSources,
      // Extract-side fields always win if extract has set them this run
      extracted: local.extracted || !!f.extracted,
      extracted_at: local.extracted_at || f.extracted_at || undefined,
      extracted_run_id: local.extracted_run_id || f.extracted_run_id || undefined,
      extracted_post_count: local.extracted_post_count !== undefined ? local.extracted_post_count : f.extracted_post_count,
      extracted_pages: local.extracted_pages !== undefined ? local.extracted_pages : f.extracted_pages,
    });
  }
  // Any threads in local not in file (shouldn't happen for extract, but defensive)
  for (const l of localThreads) {
    if (!seen.has(l.id)) merged.push(l);
  }
  merged.sort((a, b) => (a.id || 0) - (b.id || 0));
  // Per-process tmp name to avoid race with parallel discover
  const tmp = `${THREADS_JSON_PATH}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  // Windows EPERM/EBUSY can hit when multiple shards rename to same target —
  // retry with backoff.
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rename(tmp, THREADS_JSON_PATH);
      return;
    } catch (e) {
      if (e.code !== 'EPERM' && e.code !== 'EBUSY') throw e;
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 200));
    }
  }
  // Last-ditch: silently drop this persist (per-thread MDs are saved anyway,
  // metadata catches up next persist cycle).
  warn(`persistThreads: rename gave up after 10 retries; skipping this flush`);
}
