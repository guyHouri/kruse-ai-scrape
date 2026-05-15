import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import pLimit from 'p-limit';
import {
  CONCURRENCY,
  REQUEST_DELAY_MS,
} from '../settings.js';
import { fetchHtml } from './http.js';
import {
  publicThreadUrl,
  parseThreadPage,
  renderThreadFile,
} from './threadreader.js';
import { readThreads, persistThreads, ensureOutputDirs, THREADS_DIR } from './storage.js';
import { info, warn, error, section } from './logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runExtract({ limit = null } = {}) {
  section('Extract stage');
  const threads = await readThreads();
  if (threads.length === 0) {
    error('threads.json is empty or missing. Run discover first.');
    process.exit(1);
  }

  let pending = threads.filter((t) => !t.extracted);
  const totalPending = pending.length;
  pending.sort((a, b) => Number(b.published_ts || 0) - Number(a.published_ts || 0));
  if (limit && Number.isFinite(limit) && limit > 0 && limit < pending.length) {
    info(`Limiting extract to first ${limit} pending threads`);
    pending = pending.slice(0, limit);
  }
  info(`threads.json: ${threads.length} total, ${totalPending} pending, ${threads.length - totalPending} already done`);
  if (pending.length !== totalPending) {
    info(`smoke-test batch: processing ${pending.length} of ${totalPending} pending threads`);
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

  await Promise.all(pending.map((thread) => limitConcurrency(async () => {
    done++;
    const prefix = `[${done}/${pending.length}]`;
    const res = await fetchHtml(publicThreadUrl(thread.id));
    await sleep(REQUEST_DELAY_MS);
    if (!res.html) {
      failed++;
      warn(`${prefix} FAIL thread=${thread.id} - ${res.errMessage}`);
      return;
    }

    const parsed = parseThreadPage(res.html, thread);
    if (parsed.tweets.length === 0) {
      failed++;
      warn(`${prefix} FAIL thread=${thread.id} - no tweets parsed`);
      return;
    }

    const md = renderThreadFile({ thread, parsed, scrapedAt });
    await writeFile(path.join(THREADS_DIR, `${thread.id}.md`), md, 'utf-8');

    thread.extracted = true;
    thread.extracted_at = new Date().toISOString();
    thread.extracted_run_id = runId;
    thread.title = parsed.title || thread.title;
    thread.published_ts = parsed.publishedTs || thread.published_ts;
    thread.tweet_count = parsed.tweets.length;
    thread.word_count = countWords(md);
    ok++;
    unpersisted++;
    info(`${prefix} ok thread=${thread.id} tweets=${parsed.tweets.length} ${res.sizeKB}KB`);

    if (unpersisted >= PERSIST_INTERVAL) {
      await persistThreads(threads);
      unpersisted = 0;
    }
  })));

  await persistThreads(threads);
  info(`-> ok=${ok} failed=${failed}`);
}

function countWords(text) {
  const words = String(text).trim().match(/\S+/g);
  return words ? words.length : 0;
}
