import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pLimit from 'p-limit';
import {
  EXTRACTOR_USER_AGENT,
  REQUEST_TIMEOUT_MS,
  CONCURRENCY,
} from '../settings.js';
import { hasSkippedExtension } from './url-utils.js';
import { htmlToArticle, renderArticleSection, renderSiteHeader } from './extract.js';
import { deleteStaleBySlug } from './cleanup.js';
import { initLogger, info, warn, error, debug, section } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const LINKS_DIR = path.join(PROJECT_ROOT, 'links');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'processed_mds');
const WEBSITES_PATH = path.join(PROJECT_ROOT, 'websites.json');

async function loadSites() {
  return JSON.parse(await readFile(WEBSITES_PATH, 'utf-8'));
}

// Per-URL fetch result: { html, status, sizeKB, errMessage } — the extra
// fields feed the diagnostic log so a FAIL line carries context.
async function fetchHtml(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': EXTRACTOR_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'he,en-US;q=0.7,en;q=0.3',
      },
      redirect: 'follow',
    });
    if (!res.ok) return { html: null, status: res.status, sizeKB: 0, errMessage: `HTTP ${res.status}` };
    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('text/html') && !ctype.includes('application/xhtml')) {
      return { html: null, status: res.status, sizeKB: 0, errMessage: `non-html ctype=${ctype}` };
    }
    const html = await res.text();
    const sizeKB = Number((Buffer.byteLength(html, 'utf-8') / 1024).toFixed(1));
    return { html, status: res.status, sizeKB, errMessage: null };
  } catch (err) {
    return { html: null, status: 0, sizeKB: 0, errMessage: `${err.code || 'ERR'}: ${err.message}` };
  } finally {
    clearTimeout(t);
  }
}

async function processSite(site) {
  // Resolve canonical seed for header / displayHost — sites with seedUrls[]
  // (multi-entry) use the first as the host anchor; legacy entries use the
  // singular seedUrl field. Crawler does the same in crawlSite().
  const canonicalSeed = site.seedUrls?.length ? site.seedUrls[0] : site.seedUrl;

  const linksFile = path.join(LINKS_DIR, `${site.slug}.txt`);
  if (!existsSync(linksFile)) {
    error(`Links file not found for ${site.slug}: ${linksFile}. Run crawler first.`);
    return;
  }

  const raw = await readFile(linksFile, 'utf-8');
  const urls = [...new Set(raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))]
    .filter((u) => !hasSkippedExtension(u));

  await mkdir(OUTPUT_DIR, { recursive: true });

  const limit = pLimit(CONCURRENCY);
  let ok = 0, empty = 0, failed = 0;
  let done = 0;

  section(`Extracting ${site.slug} (${urls.length} urls)`);

  const results = await Promise.all(urls.map((url) => limit(async () => {
    done++;
    const prefix = `[${done}/${urls.length}]`;
    const { html, status, sizeKB, errMessage } = await fetchHtml(url);
    if (!html) {
      failed++;
      warn(`${prefix} FAIL  ${url} — ${errMessage}`);
      return null;
    }
    const article = htmlToArticle(html);
    if (!article) {
      empty++;
      debug(`${prefix} empty ${status} ${sizeKB}KB ${url}`);
      return null;
    }
    ok++;
    info(`${prefix} ok    ${status} ${sizeKB}KB ${article.title.slice(0, 60)}`);
    return { url, ...article };
  })));

  const articles = results
    .filter(Boolean)
    .sort((a, b) => a.url.localeCompare(b.url));

  const scrapedAt = new Date().toISOString();
  const exportDate = scrapedAt.slice(0, 10);
  const displayHost = new URL(canonicalSeed).hostname;
  const header = renderSiteHeader({
    slug: site.slug,
    displayHost,
    seedUrl: canonicalSeed,
    seedUrls: site.seedUrls,
    scrapedAt,
    totalArticles: articles.length,
  });

  const sections = articles.map((a) =>
    renderArticleSection({ title: a.title, body: a.body, sourceUrl: a.url })
  );

  const doc = header + sections.join('\n---\n\n');
  await deleteStaleBySlug(OUTPUT_DIR, site.slug);
  const outFile = path.join(OUTPUT_DIR, `website-${site.slug}-${exportDate}.md`);
  await writeFile(outFile, doc, 'utf-8');

  const sizeKB = (Buffer.byteLength(doc, 'utf-8') / 1024).toFixed(1);
  info(`-> ok=${ok} empty=${empty} failed=${failed}`);
  info(`-> ${path.relative(PROJECT_ROOT, outFile)} (${sizeKB} KB)`);
}

export async function runExtractor(target) {
  const sites = await loadSites();
  const picked = target
    ? sites.filter((s) => s.slug === target)
    : sites.filter((s) => s.is_active !== false);
  if (target && picked.length === 0) {
    error(`Unknown site: ${target}`);
    error(`Known: ${sites.map((s) => s.slug).join(', ')}`);
    process.exit(1);
  }
  for (const site of picked) {
    await processSite(site);
  }
}

// Direct invocation: bootstrap the logger here so a standalone extract run
// still produces a log file. main.js handles its own logger for full runs.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  initLogger({ slug: process.argv[2] || 'extract' });
  runExtractor(process.argv[2]).catch((err) => {
    error(`extractor crashed: ${err.stack || err.message}`);
    process.exit(1);
  });
}
