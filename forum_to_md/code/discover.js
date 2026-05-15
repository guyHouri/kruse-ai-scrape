// Stage 1 — Discover.
//
// Walks the forum index, enumerates every leaf subforum, fetches each one's
// first page, harvests pinned (sticky) threads, and writes the consolidated
// list to threads.json.
//
// Current discovery mode: 'pinned' (see settings.DISCOVERY_MODE). Future modes
// like 'jack' (every thread Jack has commented in) plug in here by adding
// branches that produce the same threads.json shape.

import { readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pLimit from 'p-limit';
import {
  FORUM_BASE_URL,
  REQUEST_DELAY_MS,
  CONCURRENCY,
  DISCOVERY_MODE,
} from '../settings.js';
import { fetchHtml } from './http.js';
import { parseSubforumIndex, parsePinnedThreads } from './xenforo.js';
import { info, warn, error, section } from './logger.js';
import { startProgressLog, stopProgressLog } from './progress-log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const THREADS_JSON_PATH = path.join(PROJECT_ROOT, 'threads.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runDiscover() {
  section(`Discover stage — mode=${DISCOVERY_MODE}`);
  startProgressLog('pinned-discover');

  if (DISCOVERY_MODE !== 'pinned') {
    error(`Discovery mode '${DISCOVERY_MODE}' not implemented in v1. Only 'pinned' is supported.`);
    process.exit(1);
  }

  info(`Fetching forum index ${FORUM_BASE_URL}`);
  const indexRes = await fetchHtml(FORUM_BASE_URL);
  if (!indexRes.html) {
    error(`Failed to fetch forum index: ${indexRes.errMessage}`);
    process.exit(1);
  }

  const subforums = parseSubforumIndex(indexRes.html, FORUM_BASE_URL);
  info(`Found ${subforums.length} subforums`);

  if (subforums.length === 0) {
    error('No subforums parsed from the index. Possible causes: cookies expired (HTML is a login redirect), or XenForo template changed.');
    process.exit(1);
  }

  const limit = pLimit(CONCURRENCY);
  const allThreads = [];
  const seenIds = new Set();
  let done = 0;

  const harvested = await Promise.all(subforums.map((sf) => limit(async () => {
    done++;
    const prefix = `[${done}/${subforums.length}]`;
    const res = await fetchHtml(sf.url);
    await sleep(REQUEST_DELAY_MS);
    if (!res.html) {
      warn(`${prefix} FAIL  ${sf.name} ${sf.url} — ${res.errMessage}`);
      return [];
    }
    const pinned = parsePinnedThreads(res.html, sf.url, sf.name);
    info(`${prefix} ${sf.name} → ${pinned.length} pinned`);
    return pinned;
  })));

  const discoveredAt = new Date().toISOString();
  for (const list of harvested) {
    for (const t of list) {
      if (seenIds.has(t.id)) continue;
      seenIds.add(t.id);
      allThreads.push({ ...t, discovered_at: discoveredAt });
    }
  }

  // Sort by subforum then by title for deterministic file content
  allThreads.sort((a, b) => {
    const sf = a.subforum.localeCompare(b.subforum);
    return sf !== 0 ? sf : a.title.localeCompare(b.title);
  });

  // Merge with existing threads.json instead of overwriting — preserves
  // jack-contributed entries + extracted=true flags + per-thread MD content.
  let existing = [];
  if (existsSync(THREADS_JSON_PATH)) {
    try {
      existing = JSON.parse(await readFile(THREADS_JSON_PATH, 'utf-8'));
    } catch {
      existing = [];
    }
  }
  const existingById = new Map(existing.map((t) => [t.id, t]));
  const newThreadsById = new Map(allThreads.map((t) => [t.id, t]));
  const merged = [];
  const seen = new Set();

  // First, all existing entries — update sources if also pinned
  for (const e of existing) {
    seen.add(e.id);
    const fromPinned = newThreadsById.get(e.id);
    if (fromPinned) {
      const unionSources = Array.from(new Set([...(e.sources || []), 'pinned'].filter(s => s !== 'recovered')));
      merged.push({ ...e, sources: unionSources });
    } else {
      // Strip 'recovered' tag if entry has another source; otherwise keep as-is
      const sources = (e.sources || []).filter(s => s !== 'recovered' || (e.sources || []).length === 1);
      merged.push({ ...e, sources: sources.length ? sources : ['recovered'] });
    }
  }
  // Then, any new pinned threads not in existing
  for (const t of allThreads) {
    if (seen.has(t.id)) continue;
    merged.push({
      ...t,
      sources: ['pinned'],
      extracted: false,
    });
  }
  merged.sort((a, b) => (a.id || 0) - (b.id || 0));
  const tmp = `${THREADS_JSON_PATH}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  await rename(tmp, THREADS_JSON_PATH);
  info(`-> ${allThreads.length} pinned threads merged into threads.json (total now ${merged.length})`);
  await stopProgressLog('END', { pinnedFound: allThreads.length });
  return allThreads.length;
}
