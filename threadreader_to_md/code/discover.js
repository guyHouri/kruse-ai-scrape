import {
  REQUEST_DELAY_MS,
  MAX_DISCOVERY_PAGES,
} from '../settings.js';
import { fetchHtml } from './http.js';
import { userAjaxUrl, parseUserPage } from './threadreader.js';
import { readThreads, persistThreads } from './storage.js';
import { info, warn, error, section } from './logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runDiscover() {
  section('Discover stage');
  const discoveredAt = new Date().toISOString();
  const existing = await readThreads();
  const byId = new Map(existing.map((t) => [String(t.id), t]));

  let before = null;
  let page = 0;
  let added = 0;
  let updated = 0;
  let emptyStreak = 0;

  while (page < MAX_DISCOVERY_PAGES) {
    page++;
    const url = userAjaxUrl(before);
    const res = await fetchHtml(url);
    await sleep(REQUEST_DELAY_MS);
    if (!res.html) {
      error(`Discovery fetch failed page=${page} before=${before || 'first'}: ${res.errMessage}`);
      process.exit(1);
    }

    const parsed = parseUserPage(res.html, discoveredAt);
    if (parsed.threads.length === 0) {
      emptyStreak++;
      if (emptyStreak >= 2) break;
    } else {
      emptyStreak = 0;
    }

    let pageNew = 0;
    for (const entry of parsed.threads) {
      const prev = byId.get(entry.id);
      if (prev) {
        byId.set(entry.id, {
          ...prev,
          title: entry.title || prev.title,
          preview: entry.preview || prev.preview,
          published_ts: entry.published_ts || prev.published_ts,
          published_label: entry.published_label || prev.published_label,
          tweet_count_hint: entry.tweet_count_hint || prev.tweet_count_hint,
          min_read_hint: entry.min_read_hint || prev.min_read_hint,
          url: entry.url,
        });
        updated++;
      } else {
        byId.set(entry.id, entry);
        added++;
        pageNew++;
      }
    }

    info(`  page ${page}: ${parsed.threads.length} threads, +${pageNew} new, before=${parsed.lastBefore || 'n/a'}`);
    if (!parsed.lastBefore || parsed.lastBefore === before) break;
    before = parsed.lastBefore;

    if (page % 10 === 0) {
      await persistThreads([...byId.values()]);
    }
  }

  if (page >= MAX_DISCOVERY_PAGES) {
    warn(`Reached MAX_DISCOVERY_PAGES=${MAX_DISCOVERY_PAGES}; discovery may be incomplete.`);
  }

  const merged = await persistThreads([...byId.values()]);
  info(`-> pages=${page} added=${added} updated=${updated} total=${merged.length}`);
}
