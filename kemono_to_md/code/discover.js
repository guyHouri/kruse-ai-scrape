import { LIST_PAGE_SIZE, REQUEST_DELAY_MS } from '../settings.js';
import { fetchJson } from './http.js';
import { profileApiUrl, listApiUrl, normalizeListPost } from './kemono-adapter.js';
import { readArticles, persistArticles } from './storage.js';
import { info, warn, error, section } from './logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runDiscover() {
  section('Discover stage');

  const discoveredAt = new Date().toISOString();
  const existing = await readArticles();
  const byId = new Map(existing.map((a) => [String(a.id), a]));

  let expectedCount = null;
  const profile = await fetchJson(profileApiUrl());
  if (profile.json && Number.isFinite(Number(profile.json.post_count))) {
    expectedCount = Number(profile.json.post_count);
    info(`Profile OK: expected ${expectedCount} posts`);
  } else {
    warn(`Profile fetch failed or missing post_count: ${profile.errMessage || 'missing post_count'}`);
  }
  await sleep(REQUEST_DELAY_MS);

  let offset = 0;
  let pages = 0;
  let discovered = 0;
  let added = 0;
  let updated = 0;

  while (true) {
    const url = listApiUrl(offset);
    const res = await fetchJson(url);
    await sleep(REQUEST_DELAY_MS);
    if (!res.json) {
      error(`List fetch failed at offset ${offset}: ${res.errMessage}`);
      process.exit(1);
    }
    if (!Array.isArray(res.json)) {
      error(`List fetch at offset ${offset} returned non-array JSON`);
      process.exit(1);
    }
    if (res.json.length === 0) break;

    pages++;
    info(`  page offset=${offset}: ${res.json.length} posts`);
    for (const raw of res.json) {
      const entry = normalizeListPost(raw, discoveredAt);
      if (!entry) continue;
      discovered++;
      const prev = byId.get(entry.id);
      if (prev) {
        byId.set(entry.id, {
          ...prev,
          title: entry.title || prev.title,
          published_at: entry.published_at || prev.published_at,
          added_at: entry.added_at || prev.added_at,
          url: entry.url,
          service: entry.service,
          user_id: entry.user_id,
          creator: entry.creator,
          sources: Array.from(new Set([...(prev.sources || []), 'kemono-api'])),
        });
        updated++;
      } else {
        byId.set(entry.id, entry);
        added++;
      }
    }

    offset += LIST_PAGE_SIZE;
    if (res.json.length < LIST_PAGE_SIZE) break;
    if (expectedCount !== null && offset >= expectedCount + LIST_PAGE_SIZE) break;
  }

  const merged = await persistArticles([...byId.values()]);
  info(`-> discovered=${discovered} pages=${pages} added=${added} updated=${updated} total=${merged.length}`);
}
