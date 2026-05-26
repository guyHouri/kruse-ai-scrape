// Orchestrator: scrape one UTC day of @handle tweets, resolve parents, save.

import { fetchUserTweetsForRange } from './x-api.js';
import { normalizeResponse } from './normalize.js';
import { resolveThreads } from './resolve-threads.js';
import { saveDay, loadIndex, saveIndex, getCachedTweet } from './storage.js';
import { SETTINGS } from '../settings.js';
import { info, warn } from './logger.js';

// `date` = "YYYY-MM-DD" (UTC).
// `opts.maxItems` overrides settings cap (used by --test mode).
// `opts.depthOverride` overrides thread-resolve depth (--test → 0).
export async function scrapeDay(date, opts = {}) {
  const start = `${date}T00:00:00Z`;
  const requestedEnd = `${nextUtcDate(date)}T00:00:00Z`;
  const end = capFutureEndTime(requestedEnd);
  const maxItems = opts.maxItems ?? SETTINGS.maxItemsPerDay;

  // Cost projection — bail if it could blow the configured ceiling.
  const projectedMax = maxItems * (1 + (opts.depthOverride ?? SETTINGS.maxThreadDepth) * 0.25);
  const projectedCostUsd = projectedMax * SETTINGS.costPerTweetUsd;
  info(`projected max cost for ${date}: $${projectedCostUsd.toFixed(3)} ` +
    `(${maxItems} tweets × $${SETTINGS.costPerTweetUsd} + parents)`);
  if (projectedCostUsd > SETTINGS.maxProjectedCostUsd) {
    throw new Error(`projected cost $${projectedCostUsd.toFixed(2)} exceeds maxProjectedCostUsd ` +
      `$${SETTINGS.maxProjectedCostUsd}. Lower maxItemsPerDay or raise the cap.`);
  }

  const resp = await fetchUserTweetsForRange({
    handle: SETTINGS.handle,
    start, end, maxItems,
  });

  const tweets = normalizeResponse(resp);
  info(`normalized ${tweets.length} tweets`);

  // Dedup within batch.
  const seen = new Set();
  const deduped = tweets.filter((t) => {
    if (!t.id || seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });

  await resolveThreads(deduped, {
    getCached: getCachedTweet,
    depthOverride: opts.depthOverride,
  });

  const payload = {
    date,
    handle: SETTINGS.handle,
    fetched_at: new Date().toISOString(),
    source: { backend: 'x-api-v2', endpoint: '/2/users/:id/tweets' },
    tweet_count: deduped.length,
    tweets: deduped,
  };
  saveDay(date, payload);

  const idx = loadIndex();
  for (const t of deduped) idx[t.id] = date;
  saveIndex(idx);

  const parentCount = deduped.reduce((n, t) => n + (t.thread_context?.length || 0), 0);
  info(`done ${date}: ${deduped.length} tweets, ${parentCount} parent contexts attached`);
  return payload;
}

export function capFutureEndTime(iso) {
  const requested = new Date(iso);
  const latestSafeEnd = new Date(Date.now() - 15_000);
  if (requested <= latestSafeEnd) return requested.toISOString();
  warn(`requested end_time ${requested.toISOString()} is in the future; capping to ${latestSafeEnd.toISOString()}`);
  return latestSafeEnd.toISOString();
}

function nextUtcDate(d) {
  const [y, m, day] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}
