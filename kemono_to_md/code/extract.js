import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import pLimit from 'p-limit';
import {
  CONCURRENCY,
  REQUEST_DELAY_MS,
} from '../settings.js';
import { fetchJson } from './http.js';
import {
  detailApiUrl,
  normalizeDetail,
  renderArticleFile,
  articleFilenameStem,
} from './kemono-adapter.js';
import { readArticles, persistArticles, ensureOutputDirs, ARTICLES_DIR } from './storage.js';
import { info, warn, error, section } from './logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runExtract({ limit = null } = {}) {
  section('Extract stage');
  const articles = await readArticles();
  if (articles.length === 0) {
    error('articles.json is empty or missing. Run discover first.');
    process.exit(1);
  }

  let pending = articles.filter((a) => !a.extracted);
  const totalPending = pending.length;
  pending.sort((a, b) => {
    const dateCmp = (b.published_at || b.added_at || '').localeCompare(a.published_at || a.added_at || '');
    return dateCmp !== 0 ? dateCmp : String(b.id).localeCompare(String(a.id));
  });
  if (limit && Number.isFinite(limit) && limit > 0 && limit < pending.length) {
    info(`Limiting extract to first ${limit} pending articles`);
    pending = pending.slice(0, limit);
  }

  info(`articles.json: ${articles.length} total, ${totalPending} pending, ${articles.length - totalPending} already done`);
  if (pending.length !== totalPending) {
    info(`smoke-test batch: processing ${pending.length} of ${totalPending} pending articles`);
  }
  if (pending.length === 0) return;

  await ensureOutputDirs();
  const runId = `extract-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const scrapedAt = new Date().toISOString();
  const limitConcurrency = pLimit(CONCURRENCY);
  const PERSIST_INTERVAL = 10;
  let done = 0;
  let ok = 0;
  let failed = 0;
  let unpersisted = 0;

  await Promise.all(pending.map((entry) => limitConcurrency(async () => {
    done++;
    const prefix = `[${done}/${pending.length}]`;
    const res = await fetchJson(detailApiUrl(entry.id));
    await sleep(REQUEST_DELAY_MS);
    if (!res.json) {
      failed++;
      warn(`${prefix} FAIL post=${entry.id} - ${res.errMessage}`);
      return;
    }
    const detail = normalizeDetail(res.json);
    if (!detail) {
      failed++;
      warn(`${prefix} FAIL post=${entry.id} - detail JSON missing post`);
      return;
    }

    const md = renderArticleFile({ queueEntry: entry, detail, scrapedAt });
    const outPath = path.join(ARTICLES_DIR, `${articleFilenameStem(entry)}.md`);
    await writeFile(outPath, md, 'utf-8');

    entry.extracted = true;
    entry.extracted_at = new Date().toISOString();
    entry.extracted_run_id = runId;
    entry.title = detail.title || entry.title;
    entry.published_at = detail.published_at || entry.published_at;
    entry.edited_at = detail.edited_at || entry.edited_at;
    entry.text_chars = md.length;
    ok++;
    unpersisted++;
    info(`${prefix} ok post=${entry.id} ${res.sizeKB}KB`);

    if (unpersisted >= PERSIST_INTERVAL) {
      await persistArticles(articles);
      unpersisted = 0;
    }
  })));

  await persistArticles(articles);
  info(`-> ok=${ok} failed=${failed}`);
}
