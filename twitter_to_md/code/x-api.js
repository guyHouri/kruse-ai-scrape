// Thin wrapper around the official X API v2.
//
// Endpoints used:
//   GET /2/users/by/username/:username     → resolve user_id (cached in-process)
//   GET /2/users/:id/tweets                → user timeline within time window
//   GET /2/tweets/:id                      → single tweet (for parent resolution)
//
// Auth: App-only Bearer Token (header: Authorization: Bearer <token>)
// Pricing (2026): pay-per-tweet returned; see settings.costPerTweetUsd.
// Rate limits: per-app-per-15-min; trivial at this scope.

import { SETTINGS } from '../settings.js';
import { info, warn, error } from './logger.js';

const TWEET_FIELDS = [
  'id', 'text', 'created_at', 'author_id', 'conversation_id',
  'in_reply_to_user_id', 'referenced_tweets', 'public_metrics',
  'lang', 'entities', 'attachments',
].join(',');

const USER_FIELDS = ['id', 'username', 'name'].join(',');
const MEDIA_FIELDS = ['media_key', 'type', 'url', 'preview_image_url', 'variants'].join(',');
const EXPANSIONS = [
  'author_id',
  'referenced_tweets.id',
  'referenced_tweets.id.author_id',
  'attachments.media_keys',
].join(',');

function headers() {
  if (!SETTINGS.xBearerToken) {
    throw new Error('XAPI_BEARER_TOKEN not set — copy .env.example to .env and fill it in.');
  }
  return { Authorization: `Bearer ${SETTINGS.xBearerToken}` };
}

async function xGet(pathAndQuery) {
  const url = `${SETTINGS.apiBaseUrl}${pathAndQuery}`;
  const res = await fetch(url, { headers: headers() });
  const body = await res.text();
  let json = null;
  try { json = body ? JSON.parse(body) : null; } catch { /* leave raw */ }

  if (!res.ok) {
    // Surface X API error details — they're the most useful debug info.
    error(`X API ${res.status} ${res.statusText} on ${pathAndQuery}`);
    if (json) error(`response: ${JSON.stringify(json)}`);
    else error(`response (raw): ${body.slice(0, 500)}`);
    const e = new Error(`X API ${res.status}`);
    e.status = res.status;
    e.body = json || body;
    throw e;
  }
  return json;
}

let _userIdCache = new Map();
export async function resolveUserId(username) {
  if (_userIdCache.has(username)) return _userIdCache.get(username);
  info(`x-api: resolve user id for @${username}`);
  const q = `/users/by/username/${encodeURIComponent(username)}?user.fields=${USER_FIELDS}`;
  const json = await xGet(q);
  const id = json?.data?.id;
  if (!id) throw new Error(`X API: user @${username} not found`);
  _userIdCache.set(username, id);
  return id;
}

// Fetch tweets for `handle` between `start` and `end` (ISO 8601 strings).
// Returns the full response with `data` and `includes` so the caller can
// merge referenced tweets / users / media into normalized form.
// Paginates via next_token. Stops at `maxItems` (rounded up to nearest page of 100).
export async function fetchUserTweetsForRange({ handle, start, end, maxItems }) {
  const userId = await resolveUserId(handle);
  info(`x-api: fetch @${handle} (id=${userId}) ${start} → ${end} (cap=${maxItems})`);

  const all = [];
  const includes = { users: [], tweets: [], media: [] };
  let nextToken = null;
  let pages = 0;
  const pageSize = Math.min(100, Math.max(5, maxItems));

  while (true) {
    const params = new URLSearchParams({
      'max_results': String(pageSize),
      'tweet.fields': TWEET_FIELDS,
      'expansions': EXPANSIONS,
      'user.fields': USER_FIELDS,
      'media.fields': MEDIA_FIELDS,
      'start_time': new Date(start).toISOString(),
      'end_time': new Date(end).toISOString(),
    });
    if (nextToken) params.set('pagination_token', nextToken);
    const q = `/users/${userId}/tweets?${params}`;
    const json = await xGet(q);
    pages += 1;

    const items = json?.data || [];
    all.push(...items);
    mergeIncludes(includes, json?.includes || {});
    nextToken = json?.meta?.next_token || null;

    info(`x-api: page ${pages} → +${items.length} tweets (total ${all.length})`);

    if (!nextToken) break;
    if (all.length >= maxItems) { warn(`hit maxItems=${maxItems}, stopping pagination`); break; }
  }

  return { data: all.slice(0, maxItems), includes };
}

// Fetch a single tweet by ID. Used for parent reply chain resolution.
export async function fetchTweetById(id) {
  const params = new URLSearchParams({
    'tweet.fields': TWEET_FIELDS,
    'expansions': EXPANSIONS,
    'user.fields': USER_FIELDS,
    'media.fields': MEDIA_FIELDS,
  });
  const json = await xGet(`/tweets/${id}?${params}`);
  return { data: json?.data || null, includes: json?.includes || {} };
}

// Batch fetch by IDs (up to 100 per call).
export async function fetchTweetsByIds(ids) {
  if (!ids.length) return { data: [], includes: { users: [], tweets: [], media: [] } };
  info(`x-api: batch fetch ${ids.length} tweet(s)`);
  const out = { data: [], includes: { users: [], tweets: [], media: [] } };
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const params = new URLSearchParams({
      'ids': chunk.join(','),
      'tweet.fields': TWEET_FIELDS,
      'expansions': EXPANSIONS,
      'user.fields': USER_FIELDS,
      'media.fields': MEDIA_FIELDS,
    });
    const json = await xGet(`/tweets?${params}`);
    out.data.push(...(json?.data || []));
    mergeIncludes(out.includes, json?.includes || {});
  }
  return out;
}

function mergeIncludes(target, inc) {
  for (const k of ['users', 'tweets', 'media']) {
    if (Array.isArray(inc[k])) target[k].push(...inc[k]);
  }
}
