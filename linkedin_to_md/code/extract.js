// Extract stage: fetch each article URL unauthenticated, parse <article>,
// write per-article MD to processed_mds/articles/<slug>.md. Mark
// extracted=true in articles.json (atomic merge-persist).

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pLimit from 'p-limit';
import { CONCURRENCY, REQUEST_DELAY_MS, MIN_BODY_CHARS, ARTICLE_SEPARATOR } from '../settings.js';
import { fetchHtml } from './http.js';
import { parseArticle, articleFilenameStem, canonicalArticleUrl } from './linkedin.js';
import { info, warn, error, section } from './logger.js';
import { startProgressLog, stopProgressLog, bumpWorker } from './progress-log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const ARTICLES_JSON_PATH = path.join(PROJECT_ROOT, 'articles.json');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'processed_mds');
const ARTICLES_DIR = path.join(OUTPUT_DIR, 'articles');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runExtract({ limit = null } = {}) {
  section('Extract stage');
  startProgressLog('extract');

  if (!existsSync(ARTICLES_JSON_PATH)) {
    error(`articles.json not found at ${ARTICLES_JSON_PATH}. Run discover first.`);
    process.exit(1);
  }

  const articles = JSON.parse(await readFile(ARTICLES_JSON_PATH, 'utf-8'));
  let pending = articles.filter((a) => !a.extracted);
  if (limit && Number.isFinite(limit) && limit > 0 && limit < pending.length) {
    info(`Limiting to first ${limit} pending articles (smoke-test)`);
    pending = pending.slice(0, limit);
  }
  info(`articles.json: ${articles.length} total, ${pending.length} pending`);
  if (pending.length === 0) {
    info('Nothing to extract.');
    await stopProgressLog('END', { reason: 'nothing-pending' });
    return;
  }

  await mkdir(ARTICLES_DIR, { recursive: true });
  const concurrencyLimit = pLimit(CONCURRENCY);
  const runId = `extract-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const t0 = Date.now();
  let done = 0;
  let failed = 0;
  let totalWords = 0;
  let unpersisted = 0;
  const PERSIST_INTERVAL = 10;

  await Promise.all(pending.map((article) => concurrencyLimit(async () => {
    done++;
    const prefix = `[${done}/${pending.length}]`;
    try {
      const r = await fetchHtml(article.canonical || article.url);
      await sleep(REQUEST_DELAY_MS);
      if (!r.html) {
        failed++;
        bumpWorker({ failed: 1 });
        warn(`${prefix} FAIL ${article.url} — ${r.errMessage}`);
        return;
      }
      const parsed = parseArticle(r.html);
      if (!parsed) {
        failed++;
        bumpWorker({ failed: 1 });
        warn(`${prefix} unparseable ${article.url}`);
        return;
      }
      if (parsed.bodyMd.length < MIN_BODY_CHARS) {
        failed++;
        bumpWorker({ failed: 1 });
        warn(`${prefix} too-short ${article.url} (${parsed.bodyMd.length} chars)`);
        return;
      }
      const stem = article.slug || articleFilenameStem(article.canonical || article.url) || `article-${done}`;
      const outPath = path.join(ARTICLES_DIR, `${stem}.md`);
      const articleMd = renderArticleFile({ article, parsed });
      await writeFile(outPath, articleMd, 'utf-8');
      // Update in-memory entry
      article.extracted = true;
      article.extracted_at = new Date().toISOString();
      article.extracted_run_id = runId;
      article.title = parsed.title;
      article.dateIso = article.dateIso || parsed.dateIso;
      article.word_count = parsed.wordCount;
      totalWords += parsed.wordCount;
      bumpWorker({ articlesDone: 1, words: parsed.wordCount });
      unpersisted++;
      info(`${prefix} ok ${parsed.wordCount.toLocaleString()}w — ${parsed.title.slice(0, 60)}`);
      if (unpersisted >= PERSIST_INTERVAL) {
        await persistArticles(articles);
        unpersisted = 0;
      }
    } catch (err) {
      failed++;
      bumpWorker({ failed: 1 });
      warn(`${prefix} EXC ${article.url} — ${err.message}`);
    }
  })));

  await persistArticles(articles);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const ok = pending.filter((a) => a.extracted).length;
  info(`-> articles ok=${ok} failed=${failed} words=${totalWords.toLocaleString()} elapsed=${dt}s`);
  await stopProgressLog('END', { ok, failed, words: totalWords });
}

function renderArticleFile({ article, parsed }) {
  const head = [
    ARTICLE_SEPARATOR,
    `# Article: ${parsed.title}`,
    `**Article URL:** <${article.canonical || article.url}>`,
    `**Published:** ${parsed.dateIso || article.dateIso || 'unknown'}`,
    `**Author:** ${parsed.author || 'Jack Kruse'}`,
    `**Word Count:** ${parsed.wordCount}`,
    ARTICLE_SEPARATOR,
    '',
  ].join('\n');
  return head + parsed.bodyMd + '\n';
}

async function persistArticles(localArticles) {
  // Merge-on-persist for safety against parallel runs.
  let current = [];
  try {
    current = JSON.parse(await readFile(ARTICLES_JSON_PATH, 'utf-8'));
  } catch {}
  const localByCanon = new Map(localArticles.map((a) => [a.canonical || canonicalArticleUrl(a.url), a]));
  const merged = [];
  const seen = new Set();
  for (const f of current) {
    const c = f.canonical || canonicalArticleUrl(f.url);
    if (seen.has(c)) continue;
    seen.add(c);
    const local = localByCanon.get(c);
    if (!local) { merged.push(f); continue; }
    const unionSources = Array.from(new Set([...(f.sources || []), ...(local.sources || [])]));
    merged.push({ ...f, ...local, sources: unionSources, extracted: local.extracted || !!f.extracted });
  }
  for (const l of localArticles) {
    const c = l.canonical || canonicalArticleUrl(l.url);
    if (!seen.has(c)) merged.push(l);
  }
  merged.sort((a, b) => (a.canonical || '').localeCompare(b.canonical || ''));
  const tmp = `${ARTICLES_JSON_PATH}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  for (let i = 0; i < 10; i++) {
    try { await rename(tmp, ARTICLES_JSON_PATH); return; }
    catch (e) {
      if (e.code !== 'EPERM' && e.code !== 'EBUSY') throw e;
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 200));
    }
  }
  warn('persistArticles: rename gave up after 10 retries');
}
