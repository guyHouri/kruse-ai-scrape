// Per-day forum snapshot storage.
// Path: forum_to_md/daily/<YYYY-MM-DD>.json

import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { info } from './logger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAILY_DIR = path.join(ROOT, 'daily');

function ensureDir() {
  if (!existsSync(DAILY_DIR)) mkdirSync(DAILY_DIR, { recursive: true });
}

export function dayFilePath(date) {
  return path.join(DAILY_DIR, `${date}.json`);
}

export function saveDay(date, payload) {
  ensureDir();
  const p = dayFilePath(date);
  writeFileSync(p, JSON.stringify(payload, null, 2), 'utf8');
  info(`forum-daily: wrote ${path.relative(ROOT, p)} (${payload.posts?.length || 0} posts)`);
}

export function loadDay(date) {
  const p = dayFilePath(date);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}
