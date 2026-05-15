// Single shared progress log. One file: logs/progress.log
//
// Each entry is a JSON-line. Written on stage START, every 30 min while
// running (TICK), on stage END, and on FAIL. Stats captured each time:
// threads.json counts, per-source counts, per-thread MD file count,
// quarterly bundle count.

import { appendFile, readFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const LOGS_DIR = path.join(PROJECT_ROOT, 'logs');
// Two log files:
//   logs/progress.log — sparse rows: START / TICK (every 30 min) / END / COOKIES_EXPIRED
//   logs/workers.log  — dense rows : every 1 min, one row per worker, what it has achieved
const PROGRESS_LOG = path.join(LOGS_DIR, 'progress.log');
const WORKERS_LOG = path.join(LOGS_DIR, 'workers.log');
const THREADS_JSON_PATH = path.join(PROJECT_ROOT, 'threads.json');
const THREADS_DIR = path.join(PROJECT_ROOT, 'processed_mds', 'threads');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'processed_mds');

const TICK_MS = 30 * 60 * 1000;  // 30 minutes → progress.log
const WORKER_TICK_MS = 60 * 1000; // 1 minute → workers.log

let timerId = null;
let workerTimerId = null;
let currentStage = null;
let currentExtra = null;
let workerStartTs = null;
let workerCounters = { threadsDone: 0, postsExtracted: 0, pagesFetched: 0, failed: 0 };

export function startProgressLog(stageName, extra = null) {
  currentStage = stageName;
  currentExtra = extra;
  workerStartTs = Date.now();
  workerCounters = { threadsDone: 0, postsExtracted: 0, pagesFetched: 0, failed: 0 };
  writeRow('START').catch(() => {});
  writeWorkerRow().catch(() => {});
  timerId = setInterval(() => writeRow('TICK').catch(() => {}), TICK_MS);
  workerTimerId = setInterval(() => writeWorkerRow().catch(() => {}), WORKER_TICK_MS);
  if (timerId.unref) timerId.unref();
  if (workerTimerId.unref) workerTimerId.unref();
}

export function stopProgressLog(reason = 'END', extra = null) {
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }
  if (workerTimerId) {
    clearInterval(workerTimerId);
    workerTimerId = null;
  }
  if (extra) currentExtra = { ...(currentExtra || {}), ...extra };
  // Final worker row + progress row
  writeWorkerRow(reason).catch(() => {});
  return writeRow(reason).catch(() => {});
}

// Workers call this to bump their own counters; the 1-min ticker emits them.
export function bumpWorker({ threadsDone = 0, postsExtracted = 0, pagesFetched = 0, failed = 0 } = {}) {
  workerCounters.threadsDone += threadsDone;
  workerCounters.postsExtracted += postsExtracted;
  workerCounters.pagesFetched += pagesFetched;
  workerCounters.failed += failed;
}

export async function writeProgressRow(event, extra = null) {
  if (extra) currentExtra = { ...(currentExtra || {}), ...extra };
  await writeRow(event);
}

async function writeRow(event) {
  if (!existsSync(LOGS_DIR)) {
    await mkdir(LOGS_DIR, { recursive: true });
  }
  const ts = new Date().toISOString();
  let stats = {};
  try {
    stats = await collectStats();
  } catch (e) {
    stats = { stats_error: e.message };
  }
  const row = {
    ts,
    event,
    stage: currentStage,
    pid: process.pid,
    ...stats,
    ...(currentExtra || {}),
  };
  // Human-readable single-line format: timestamp | event | stage | pid | k=v k=v ...
  const flat = flatten(row);
  const human = `${ts} | ${event.padEnd(16)} | stage=${currentStage || '-'} | pid=${process.pid} | ${flat}`;
  try {
    await appendFile(PROGRESS_LOG, human + '\n', 'utf-8');
  } catch (e) {
    // best effort
  }
}

async function writeWorkerRow(event = 'TICK') {
  if (!existsSync(LOGS_DIR)) {
    await mkdir(LOGS_DIR, { recursive: true });
  }
  const ts = new Date().toISOString();
  const elapsedSec = workerStartTs ? Math.round((Date.now() - workerStartTs) / 1000) : 0;
  const row = `${ts} | ${(event).padEnd(8)} | stage=${(currentStage || '-').padEnd(28)} | pid=${String(process.pid).padEnd(6)} | elapsed=${String(elapsedSec).padStart(6)}s | threads_done=${workerCounters.threadsDone} posts=${workerCounters.postsExtracted} pages=${workerCounters.pagesFetched} failed=${workerCounters.failed}`;
  try {
    await appendFile(WORKERS_LOG, row + '\n', 'utf-8');
  } catch (e) {}
}

function flatten(row) {
  const parts = [];
  for (const [k, v] of Object.entries(row)) {
    if (k === 'ts' || k === 'event' || k === 'stage' || k === 'pid') continue;
    if (v && typeof v === 'object') {
      for (const [k2, v2] of Object.entries(v)) {
        parts.push(`${k}.${k2}=${v2}`);
      }
    } else {
      parts.push(`${k}=${v}`);
    }
  }
  return parts.join(' ');
}

async function collectStats() {
  const stats = {};
  // threads.json
  if (existsSync(THREADS_JSON_PATH)) {
    try {
      const raw = await readFile(THREADS_JSON_PATH, 'utf-8');
      const arr = JSON.parse(raw);
      stats.threads_total = arr.length;
      let extracted = 0, pending = 0;
      const sourceCounts = { pinned: 0, 'jack-contributed': 0, 'discovered-via-subforum': 0, recovered: 0 };
      let jackInvolved = 0;
      for (const t of arr) {
        if (t.extracted) extracted++; else pending++;
        for (const s of (t.sources || [])) {
          if (sourceCounts[s] !== undefined) sourceCounts[s]++;
        }
        if ((t.sources || []).includes('jack-contributed') || (t.sources || []).includes('pinned')) jackInvolved++;
      }
      stats.threads_extracted = extracted;
      stats.threads_pending = pending;
      stats.sources = sourceCounts;
      stats.threads_jack_or_pinned = jackInvolved;
    } catch {
      stats.threads_json_error = true;
    }
  }
  // per-thread MD count
  if (existsSync(THREADS_DIR)) {
    try {
      const files = await readdir(THREADS_DIR);
      stats.md_files = files.filter((n) => /\.md$/.test(n)).length;
    } catch {}
  }
  // bundle MD count
  if (existsSync(OUTPUT_DIR)) {
    try {
      const files = await readdir(OUTPUT_DIR);
      stats.bundle_files = files.filter((n) => /^forum-jackkruse-.*\.md$/.test(n) || /-threads\.md$/.test(n)).length;
    } catch {}
  }
  return stats;
}
