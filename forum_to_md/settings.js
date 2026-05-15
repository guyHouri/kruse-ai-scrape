// ============================================================
// settings.js — all tunables for forum_to_md
// ============================================================
//
// Cookies are NOT hard-coded in this file. They are loaded at runtime from
// the user's local cookies.txt (which is gitignored). See SETUP.md for the
// step-by-step on how to populate it.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIES_TXT = path.join(__dirname, 'cookies.txt');

function loadCookies() {
  // Priority 1: env var XENFORO_COOKIE
  if (process.env.XENFORO_COOKIE && process.env.XENFORO_COOKIE.trim()) {
    return process.env.XENFORO_COOKIE.trim();
  }
  // Priority 2: cookies.txt file at project root
  if (existsSync(COOKIES_TXT)) {
    const raw = readFileSync(COOKIES_TXT, 'utf-8').trim();
    if (raw && !raw.startsWith('#')) return raw;
  }
  return '';
}

export const FORUM_BASE_URL = 'https://forum.jackkruse.com';

// Logged-in XenForo session cookie string. See SETUP.md for how to populate.
// Format: `xf_user=...; xf_csrf=...; xf_session=...`
export const XENFORO_COOKIE = loadCookies();

if (!XENFORO_COOKIE) {
  console.warn('[settings] XENFORO_COOKIE is empty. Run will fail with HTTP 403. See SETUP.md.');
}

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Networking
export const REQUEST_DELAY_MS = 600;        // polite delay between fetches on the same in-flight chain
export const REQUEST_TIMEOUT_MS = 20000;
export const CONCURRENCY = 5;               // parallel thread fetches in extract stage (per shard; 3 shards × 5 = 15 total concurrent)
export const RETRY_COUNT = 2;               // transient retries per request

// Discovery
export const DISCOVERY_MODE = 'pinned';     // v1: 'pinned'. Future: 'jack', 'manual'
export const JACK_MEMBER_ID = 1031;         // Jack Kruse's XenForo member id (used by jack-discover)

// Extraction
export const MIN_POST_BODY_CHARS = 20;      // drop posts whose body markdown is shorter (typically "+1", emoji-only)
export const MAX_THREAD_PAGES = 200;        // safety cap; a runaway pagination loop should never harvest >200 pages

// Output
export const THREAD_SEPARATOR = '═'.repeat(70); // strong visual + grep-able boundary between threads
