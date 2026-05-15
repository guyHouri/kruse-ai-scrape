import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import {
  CRAWLER_USER_AGENT,
  REQUEST_DELAY_MS,
  REQUEST_TIMEOUT_MS,
} from '../settings.js';
import { normalizeUrl, sameRegistrableHost, hasSkippedExtension } from './url-utils.js';
import { initLogger, info, warn, error, debug, trace, section, getLogFilePath } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const LINKS_DIR = path.join(PROJECT_ROOT, 'links');
const WEBSITES_PATH = path.join(PROJECT_ROOT, 'websites.json');

async function loadSites() {
  return JSON.parse(await readFile(WEBSITES_PATH, 'utf-8'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(url, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': CRAWLER_USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'he,en-US;q=0.7,en;q=0.3',
        },
        redirect: 'follow',
      });
      clearTimeout(t);
      const ctype = res.headers.get('content-type') || '';
      if (!res.ok) {
        warn(`fetch ${res.status} ${url.slice(0, 100)} ctype=${ctype}`);
        return null;
      }
      if (!ctype.includes('text/html') && !ctype.includes('application/xhtml')) {
        debug(`skip non-html ${ctype} ${url.slice(0, 100)}`);
        return null;
      }
      const text = await res.text();
      const sizeKB = (Buffer.byteLength(text, 'utf-8') / 1024).toFixed(1);
      debug(`GET ${res.status} ${sizeKB} KB ${url.slice(0, 100)}`);
      return text;
    } catch (err) {
      clearTimeout(t);
      if (attempt === retries) {
        error(`fetch failed ${url.slice(0, 100)}: ${err.message}`);
        return null;
      }
      debug(`retry ${attempt + 1}/${retries} after error: ${err.message}`);
      await sleep(1000);
    }
  }
  return null;
}

// Extract anchors from HTML, returning a normalized list plus a breakdown of
// what got rejected. The breakdown is what reveals UA-sniff cases (raw=0 or 1
// = stub HTML) vs cross-domain-fanout cases vs SPA cases (raw>0 but mostly
// hash/javascript: links).
function extractLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const anchors = $('a[href]');
  const out = new Set();
  let rejectedNullNorm = 0;
  anchors.each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const norm = normalizeUrl(href, baseUrl);
    if (!norm) {
      rejectedNullNorm++;
      return;
    }
    out.add(norm);
  });
  return { links: [...out], rawAnchors: anchors.length, rejectedNullNorm };
}

async function crawlSite(site) {
  const seeds = site.seedUrls?.length ? site.seedUrls : [site.seedUrl];
  section(`Crawling ${site.slug}`);
  info(`seeds=${seeds.length} maxDepth=${site.maxDepth} delay=${REQUEST_DELAY_MS}ms`);
  for (const s of seeds) info(`  seed: ${s}`);

  const seedNorms = seeds.map((u) => normalizeUrl(u, u));
  if (seedNorms.some((s) => !s)) {
    error(`Invalid seed URL in ${site.slug}: ${seeds.join(', ')}`);
    throw new Error(`Invalid seed URL in ${site.slug}`);
  }
  const hostAnchor = seedNorms[0];

  const visited = new Set();
  const collected = new Set();
  const queue = seedNorms.map((url) => ({ url, depth: 0 }));

  let pagesFetched = 0;
  let totalSameHostKept = 0;
  let totalCrossHostRejected = 0;
  let totalExtRejected = 0;
  let totalAlreadyVisited = 0;

  while (queue.length) {
    const { url, depth } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    if (hasSkippedExtension(url)) {
      totalExtRejected++;
      continue;
    }
    if (!sameRegistrableHost(url, hostAnchor)) {
      collected.add(url);
      totalCrossHostRejected++;
      continue;
    }

    collected.add(url);
    if (depth >= site.maxDepth) continue;

    info(`[d${depth}] ${url}`);
    const html = await fetchHtml(url);
    await sleep(REQUEST_DELAY_MS);
    if (!html) continue;
    pagesFetched++;

    const { links, rawAnchors, rejectedNullNorm } = extractLinks(html, url);
    let sameHost = 0;
    let crossHost = 0;
    let extRejected = 0;
    let alreadyVisited = 0;
    for (const link of links) {
      if (visited.has(link)) {
        alreadyVisited++;
        continue;
      }
      if (hasSkippedExtension(link)) {
        extRejected++;
        continue;
      }
      if (sameRegistrableHost(link, hostAnchor)) {
        queue.push({ url: link, depth: depth + 1 });
        sameHost++;
      } else {
        collected.add(link);
        crossHost++;
      }
    }
    debug(`  anchors=${rawAnchors} unique=${links.length} → kept=${sameHost} cross=${crossHost} ext=${extRejected} dup=${alreadyVisited} bad=${rejectedNullNorm}`);
    totalSameHostKept += sameHost;
    totalCrossHostRejected += crossHost;
    totalExtRejected += extRejected;
    totalAlreadyVisited += alreadyVisited;
  }

  const sameDomain = [...collected].filter((u) => sameRegistrableHost(u, hostAnchor));
  await mkdir(LINKS_DIR, { recursive: true });
  const outFile = path.join(LINKS_DIR, `${site.slug}.txt`);
  await writeFile(outFile, sameDomain.join('\n') + '\n', 'utf-8');
  info(`-> ${sameDomain.length} same-domain links written to ${path.relative(PROJECT_ROOT, outFile)}`);
  info(`   pagesFetched=${pagesFetched} visited=${visited.size} kept=${totalSameHostKept} cross=${totalCrossHostRejected} ext=${totalExtRejected} dup=${totalAlreadyVisited}`);
  return sameDomain.length;
}

export async function runCrawler(target) {
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
    await crawlSite(site);
  }
}

// When invoked directly (`node code/crawler.js [slug]`), bootstrap the logger
// here so a standalone crawl run still produces a log file. main.js initializes
// its own logger for full pipeline runs.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  initLogger({ slug: process.argv[2] || 'crawl' });
  runCrawler(process.argv[2]).catch((err) => {
    error(`crawler crashed: ${err.stack || err.message}`);
    process.exit(1);
  });
}
