// For every reply tweet, walk up the parent chain so AI sees full context.
//
// Strategy:
//   1. Collect all `in_reply_to.tweet_id` from current batch where the parent
//      is not already in our lookup (batch + cached on disk).
//   2. Batch-fetch missing parents via fetchTweetsByIds.
//   3. Normalize, add to lookup, repeat until depth cap hit or no new parents.
//   4. For each reply tweet, walk parent pointers to build thread_context array.

import { fetchTweetsByIds } from './x-api.js';
import { normalizeResponse } from './normalize.js';
import { SETTINGS } from '../settings.js';
import { info, warn } from './logger.js';

// `getCached(id)` returns a normalized tweet from on-disk cache or null.
export async function resolveThreads(tweets, { getCached, depthOverride } = {}) {
  const byId = new Map();
  for (const t of tweets) if (t.id) byId.set(t.id, t);

  const maxDepth = depthOverride ?? SETTINGS.maxThreadDepth;
  let depth = 0;
  while (depth < maxDepth) {
    const missing = new Set();
    for (const t of byId.values()) {
      const pid = t.in_reply_to?.tweet_id;
      if (!pid) continue;
      if (byId.has(pid)) continue;
      const cached = getCached ? getCached(pid) : null;
      if (cached) { byId.set(pid, cached); continue; }
      missing.add(pid);
    }
    if (!missing.size) break;

    info(`thread-resolve depth=${depth + 1}: fetching ${missing.size} parent(s)`);
    let fetched;
    try {
      fetched = await fetchTweetsByIds([...missing]);
    } catch (e) {
      warn(`parent fetch failed at depth=${depth + 1}: ${e.message}. Continuing with partial chain.`);
      break;
    }
    const normalized = normalizeResponse(fetched);
    for (const n of normalized) if (n?.id) byId.set(n.id, n);
    depth += 1;
  }

  // Attach thread_context (root → direct parent) to each reply tweet in original batch.
  for (const t of tweets) {
    if (!t.in_reply_to?.tweet_id) continue;
    const chain = [];
    let cur = byId.get(t.in_reply_to.tweet_id);
    const seen = new Set();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      const { thread_context, ...rest } = cur;
      chain.unshift(rest);
      cur = cur.in_reply_to?.tweet_id ? byId.get(cur.in_reply_to.tweet_id) : null;
    }
    t.thread_context = chain;
  }
  return tweets;
}
