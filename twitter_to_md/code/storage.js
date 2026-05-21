// JSON-on-disk storage. One file per UTC day under data/, plus a global
// index.json (tweet_id → date) for dedup + cross-day parent lookup.
//
// Layout:
//   data/
//     2026-05-21.json    { date, handle, fetched_at, tweets: [...] }
//     2026-05-22.json
//     index.json         { "1234...": "2026-05-21", ... }

import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS } from '../settings.js';
import { info } from './logger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, SETTINGS.dataDir);
const INDEX_PATH = path.join(ROOT, SETTINGS.indexFile);

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function dayFilePath(date) {
  return path.join(DATA_DIR, `${date}.json`);
}

export function loadDay(date) {
  const p = dayFilePath(date);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function saveDay(date, payload) {
  ensureDir();
  const p = dayFilePath(date);
  writeFileSync(p, JSON.stringify(payload, null, 2), 'utf8');
  info(`wrote ${path.relative(ROOT, p)} (${payload.tweets.length} tweets)`);
}

export function loadIndex() {
  if (!existsSync(INDEX_PATH)) return {};
  return JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
}

export function saveIndex(idx) {
  ensureDir();
  writeFileSync(INDEX_PATH, JSON.stringify(idx, null, 2), 'utf8');
}

// Look up a previously-saved tweet anywhere in data/ by id. Used to avoid
// re-fetching parent tweets that already live on disk from prior days.
let _cache = null;
function buildCache() {
  if (_cache) return _cache;
  _cache = new Map();
  if (!existsSync(DATA_DIR)) return _cache;
  for (const fname of readdirSync(DATA_DIR)) {
    if (!fname.endsWith('.json') || fname === 'index.json') continue;
    try {
      const day = JSON.parse(readFileSync(path.join(DATA_DIR, fname), 'utf8'));
      for (const t of day.tweets || []) {
        if (t.id) _cache.set(t.id, t);
        for (const ctx of t.thread_context || []) {
          if (ctx.id) _cache.set(ctx.id, ctx);
        }
      }
    } catch { /* skip corrupt file */ }
  }
  return _cache;
}
export function getCachedTweet(id) {
  return buildCache().get(id) || null;
}
