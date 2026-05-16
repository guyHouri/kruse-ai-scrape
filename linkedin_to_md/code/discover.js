// Discover stage:
//   1. Read xlsx LinkedIn sheet → seed article URL list (xlsx is the archive
//      that has 1011 entries up to April 2024).
//   2. Playwright headed login → load /in/<profile>/recent-activity/articles/
//      → scroll to bottom → harvest every /pulse/ link found in the DOM.
//   3. Merge with xlsx URLs (dedupe), persist to articles.json with
//      `extracted: false`.
//
// articles.json schema per entry:
//   { url, canonical, title, slug, source: 'xlsx'|'profile-scrape', dateIso, discovered_at, extracted: bool }

import { readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import XLSX from 'xlsx';
import {
  ARTICLES_XLSX,
  XLSX_SHEET,
  ARTICLES_LIST_URL,
  LINKEDIN_CREDS,
  USER_AGENT,
} from '../settings.js';
import { canonicalArticleUrl, articleFilenameStem } from './linkedin.js';
import { info, warn, error, section } from './logger.js';
import { startProgressLog, stopProgressLog } from './progress-log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const ARTICLES_JSON_PATH = path.join(PROJECT_ROOT, 'articles.json');
const XLSX_PATH = path.join(PROJECT_ROOT, ARTICLES_XLSX);

const PULSE_URL_RE = /https?:\/\/(?:www\.)?linkedin\.com\/pulse\/[^\s"'<>?]+/g;

export async function runDiscover() {
  section('Discover stage');
  startProgressLog('discover');

  // --- 1. Seed from xlsx ---
  const xlsxEntries = readXlsxLinkedinSheet(XLSX_PATH, XLSX_SHEET);
  info(`xlsx: ${xlsxEntries.length} LinkedIn URLs from ${XLSX_SHEET}`);

  // --- 2. Playwright login + scrape recent-activity articles page ---
  let profileEntries = [];
  if (!LINKEDIN_CREDS.user || !LINKEDIN_CREDS.pass) {
    warn('No LINKEDIN_USER/LINKEDIN_PASS in credentials.txt or env — skipping profile scrape, using xlsx URLs only');
  } else {
    try {
      profileEntries = await scrapeProfileArticleList();
      info(`profile scrape: ${profileEntries.length} URLs harvested from ${ARTICLES_LIST_URL}`);
    } catch (e) {
      warn(`Profile scrape failed: ${e.message} — falling back to xlsx-only seed`);
    }
  }

  // --- 3. Merge + dedupe by canonical URL ---
  const byCanonical = new Map();
  const discoveredAt = new Date().toISOString();
  for (const e of xlsxEntries) {
    const canonical = canonicalArticleUrl(e.url);
    if (byCanonical.has(canonical)) continue;
    byCanonical.set(canonical, {
      url: e.url,
      canonical,
      slug: articleFilenameStem(canonical),
      title: e.title || null,
      dateIso: e.dateIso || null,
      sources: ['xlsx'],
      discovered_at: discoveredAt,
      extracted: false,
    });
  }
  for (const e of profileEntries) {
    const canonical = canonicalArticleUrl(e.url);
    const existing = byCanonical.get(canonical);
    if (existing) {
      if (!existing.sources.includes('profile-scrape')) existing.sources.push('profile-scrape');
    } else {
      byCanonical.set(canonical, {
        url: e.url,
        canonical,
        slug: articleFilenameStem(canonical),
        title: e.title || null,
        dateIso: e.dateIso || null,
        sources: ['profile-scrape'],
        discovered_at: discoveredAt,
        extracted: false,
      });
    }
  }

  // --- 4. Merge into existing articles.json (preserve extracted=true) ---
  let existing = [];
  if (existsSync(ARTICLES_JSON_PATH)) {
    try { existing = JSON.parse(await readFile(ARTICLES_JSON_PATH, 'utf-8')); } catch {}
  }
  const existingByCanonical = new Map(existing.map((e) => [e.canonical || canonicalArticleUrl(e.url), e]));
  const merged = [];
  for (const [canonical, fresh] of byCanonical) {
    const old = existingByCanonical.get(canonical);
    if (old) {
      merged.push({
        ...old,
        ...fresh,
        sources: Array.from(new Set([...(old.sources || []), ...fresh.sources])),
        extracted: !!old.extracted,
        extracted_at: old.extracted_at,
        extracted_run_id: old.extracted_run_id,
        word_count: old.word_count,
      });
    } else {
      merged.push(fresh);
    }
  }
  // Preserve any existing entries that aren't in current discovery (shouldn't happen, but defensive)
  for (const e of existing) {
    const c = e.canonical || canonicalArticleUrl(e.url);
    if (!byCanonical.has(c)) merged.push(e);
  }

  merged.sort((a, b) => (a.canonical || '').localeCompare(b.canonical || ''));
  await persistAtomic(ARTICLES_JSON_PATH, JSON.stringify(merged, null, 2) + '\n');

  const newCount = merged.length - existing.length;
  info(`-> articles.json now has ${merged.length} entries (+${newCount} new this run)`);
  await stopProgressLog('END', { totalArticles: merged.length, fromXlsx: xlsxEntries.length, fromProfileScrape: profileEntries.length });
}

// --- xlsx reader ---

function readXlsxLinkedinSheet(xlsxPath, sheetName) {
  if (!existsSync(xlsxPath)) {
    warn(`xlsx not found at ${xlsxPath} — skipping`);
    return [];
  }
  const wb = XLSX.readFile(xlsxPath);
  const ws = wb.Sheets[sheetName];
  if (!ws) {
    warn(`xlsx sheet '${sheetName}' not found — skipping`);
    return [];
  }
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
  const out = [];
  for (let i = 1; i < rows.length; i++) {  // skip header
    const r = rows[i];
    if (!r || r.length === 0) continue;
    const title = r[0] && String(r[0]).trim();
    const url = r[1] && String(r[1]).trim();
    if (!url || !/\/pulse\//.test(url)) continue;
    // Date column is an Excel serial number — convert
    let dateIso = null;
    if (typeof r[2] === 'number') {
      const epoch = new Date(Date.UTC(1899, 11, 30));
      const ms = r[2] * 86400000;
      const d = new Date(epoch.getTime() + ms);
      if (!Number.isNaN(d.getTime())) dateIso = d.toISOString().slice(0, 10);
    } else if (typeof r[2] === 'string' && /\d{4}-\d{2}-\d{2}/.test(r[2])) {
      dateIso = r[2];
    }
    out.push({ url, title, dateIso });
  }
  return out;
}

// --- Playwright login + scroll harvest ---

async function scrapeProfileArticleList() {
  info('Launching headed Playwright for one-time login + URL harvest...');
  const browser = await chromium.launch({ headless: false });
  try {
    const ctx = await browser.newContext({ userAgent: USER_AGENT });
    const page = await ctx.newPage();

    // 1. Login
    info('Loading login page...');
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
    // LinkedIn varies selectors: try session_key/session_password (classic) then username/password (newer)
    const userSel = await page.waitForSelector('input[name="session_key"], input#username', { timeout: 30_000 });
    await userSel.fill(LINKEDIN_CREDS.user);
    const passSel = await page.$('input[name="session_password"], input#password');
    await passSel.fill(LINKEDIN_CREDS.pass);
    await page.click('button[type="submit"]');
    // Wait for either feed or challenge
    try {
      await page.waitForURL(/\/feed\/|\/checkpoint\/|\/in\/|\/home\//i, { timeout: 30_000 });
    } catch {
      // continue regardless — may be on /feed/ already
    }
    const postLoginUrl = page.url();
    info(`Post-login URL: ${postLoginUrl}`);
    if (/checkpoint|challenge/i.test(postLoginUrl)) {
      warn('LinkedIn challenge page hit — solve it in the visible browser, then press Enter in this terminal.');
      // Wait for manual completion: poll until we leave the challenge page
      while (/checkpoint|challenge/i.test(page.url())) {
        await page.waitForTimeout(5000);
      }
      info('Challenge cleared, continuing.');
    }

    // 2. Articles list page
    info(`Navigating to ${ARTICLES_LIST_URL}`);
    await page.goto(ARTICLES_LIST_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // 3. Scroll to bottom to load all articles (LinkedIn infinite-scroll)
    let lastHeight = 0;
    let sameHeightStreak = 0;
    let scrolls = 0;
    while (sameHeightStreak < 5 && scrolls < 200) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);
      const h = await page.evaluate(() => document.body.scrollHeight);
      if (h === lastHeight) sameHeightStreak++; else sameHeightStreak = 0;
      lastHeight = h;
      scrolls++;
      if (scrolls % 10 === 0) info(`  scrolled ${scrolls} times, height=${h}`);
    }
    info(`Scroll complete after ${scrolls} iterations, final height=${lastHeight}`);

    // 4. Harvest /pulse/ URLs from the rendered page
    const html = await page.content();
    const urls = new Set();
    const matches = html.match(PULSE_URL_RE) || [];
    for (const m of matches) {
      // Strip trailing punctuation/quotes
      const clean = m.replace(/[\\"',)>}\s]+$/, '');
      urls.add(clean);
    }
    const out = [];
    for (const u of urls) {
      out.push({ url: u, title: null, dateIso: null });
    }
    return out;
  } finally {
    await browser.close();
  }
}

async function persistAtomic(filePath, content) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmp, content, 'utf-8');
  for (let i = 0; i < 5; i++) {
    try { await rename(tmp, filePath); return; }
    catch (e) {
      if (e.code !== 'EPERM' && e.code !== 'EBUSY') throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  await rename(tmp, filePath);
}
