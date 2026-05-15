// Stage 3 — Split + Index.
//
// Reads per-thread MDs (one per extracted thread, in processed_mds/threads/<slug>.<id>.md)
// and packs them chronologically into NotebookLM-sized bundles named
// forum#1.md, forum#2.md, ..., forum#N.md.
//
// NotebookLM hard limits per source:  500 000 words / 200 MB
// NotebookLM total per notebook:      50 sources / 25 000 000 words
// We stay under those with safety margins below.

import { readFile, writeFile, mkdir, readdir, unlink, rename, stat } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import { THREAD_SEPARATOR, FORUM_BASE_URL } from '../settings.js';
import { threadFilenameStem } from './url-utils.js';
import { info, warn, error, section } from './logger.js';
import { startProgressLog, stopProgressLog } from './progress-log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'processed_mds');
const THREADS_DIR = path.join(OUTPUT_DIR, 'threads');
const THREADS_JSON_PATH = path.join(PROJECT_ROOT, 'threads.json');

// File-name patterns we consider OBSOLETE legacy bundle outputs — they get
// removed before the new forum#N.md series is written.
const LEGACY_BUNDLE_PATTERNS = [
  /^forum-jackkruse-\d{4}-\d{2}-\d{2}\.md$/,           // master <date>.md
  /^forum-jackkruse-\d{4}(?:-Q[1-4])?(?:-M[1-3])?\.md$/, // year/quarter/month buckets
  /^forum-jackkruse-unknown(?:-Q[1-4])?(?:-M[1-3])?\.md$/, // unknown-year buckets
  /^monster(?:-\d+)?\.md$/,                              // monster.md / monster-N.md
  /^jack-threads(?:-\d+)?\.md$/,                         // jack-threads.md / jack-threads-N.md
  /^not-jack-threads\.md$/,
  /^optimal-journal-threads\.md$/,
  /^meet-and-greet-threads\.md$/,
];
const FORUM_PART_RE = /^forum#\d+\.md$/;

const PER_THREAD_FILE_RE = /^.+\.\d+\.md$/;    // <slug>.<id>.md
const LEGACY_THREAD_FILE_RE = /^\d+\.md$/;     // legacy <id>.md

// NotebookLM per-source caps — every bundle part stays under these.
// File count is INTENTIONALLY unbounded: this project also serves
// non-NotebookLM consumers (grep, full-archive analysis). If a NotebookLM user
// hits the 50-source limit, they pick the top 50 forum#N.md parts by date or
// category. Single threads bigger than the per-file cap get their own
// oversized part (NotebookLM accepts up to 500 k words / 200 MB strict).
const MAX_WORDS_PER_FILE  = 490_000;
const MAX_BYTES_PER_FILE  = 195 * 1024 * 1024;

export async function runSplit() {
  section('Split + Index stage');
  startProgressLog('split');

  // --- Load threads.json universe ---
  let universe;
  try {
    universe = JSON.parse(await readFile(THREADS_JSON_PATH, 'utf-8'));
  } catch (e) {
    error(`Cannot read threads.json: ${e.message}`);
    process.exit(1);
  }
  for (const t of universe) {
    if (!Array.isArray(t.sources)) t.sources = t.source ? [t.source] : ['pinned'];
    delete t.source;
    if (t.extracted === undefined) t.extracted = false;
  }
  info(`threads.json universe: ${universe.length} threads, ${universe.filter(t => t.extracted).length} extracted`);

  // --- Migrations (legacy MDs → per-thread, legacy filenames → slug.id.md) ---
  await migrateLegacyMdsIfNeeded(universe);
  await renameLegacyThreadFiles(universe);

  // --- Parse every per-thread MD: stats + word count ---
  const idToStats = new Map();
  await mkdir(THREADS_DIR, { recursive: true });
  const threadFiles = (await readdir(THREADS_DIR)).filter((n) => PER_THREAD_FILE_RE.test(n) || LEGACY_THREAD_FILE_RE.test(n));
  info(`Reading ${threadFiles.length} per-thread MDs from ${path.relative(PROJECT_ROOT, THREADS_DIR)}`);
  for (const f of threadFiles) {
    const idM = f.match(/\.?(\d+)\.md$/);
    if (!idM) continue;
    const id = Number(idM[1]);
    const md = await readFile(path.join(THREADS_DIR, f), 'utf-8');
    const stats = parseThreadStats(md);
    idToStats.set(id, { md, ...stats });
  }

  // --- Sort all extracted threads chronologically (firstDate ASC) ---
  const allExtracted = [];
  for (const t of universe) {
    if (!t.extracted) continue;
    const s = idToStats.get(t.id);
    if (!s) {
      warn(`Thread ${t.id} extracted=true but no per-thread MD; skipping.`);
      continue;
    }
    allExtracted.push({ thread: t, stats: s });
  }
  allExtracted.sort((a, b) => {
    const da = a.stats.firstDate || 'zzzz';
    const db = b.stats.firstDate || 'zzzz';
    if (da !== db) return da.localeCompare(db);
    return (a.thread.id || 0) - (b.thread.id || 0);
  });
  info(`Sorted ${allExtracted.length} extracted threads chronologically`);

  // --- Clean prior bundles (year/quarter/master/monster/jack-threads/categories) ---
  for (const n of await readdir(OUTPUT_DIR)) {
    if (LEGACY_BUNDLE_PATTERNS.some((re) => re.test(n)) || FORUM_PART_RE.test(n)) {
      await unlink(path.join(OUTPUT_DIR, n));
    }
  }

  // --- Pack into forum#N.md parts ---
  // Each part: <450k words AND <190MB. Stop at 50 parts or 25M total words.
  const scrapedAt = new Date().toISOString();
  const parts = packIntoParts(allExtracted);
  const idToBundleFile = new Map();
  let totalWordsWritten = 0;
  let partsWritten = 0;
  for (let i = 0; i < parts.length; i++) {
    const partItems = parts[i];
    const partWords = partItems.reduce((a, it) => a + it.stats.wordCount, 0);
    const name = `forum#${i + 1}.md`;
    const outPath = path.join(OUTPUT_DIR, name);
    await writePartFile({
      outPath,
      partItems,
      partIndex: i + 1,
      totalParts: parts.length,
      partWords,
      scrapedAt,
      totalThreadsOverall: allExtracted.length,
    });
    const { size } = await stat(outPath);
    for (const it of partItems) idToBundleFile.set(it.thread.id, name);
    info(`  ${name}: ${partItems.length} threads, ${partWords.toLocaleString()} words, ${(size / 1024 / 1024).toFixed(2)} MB`);
    partsWritten++;
    totalWordsWritten += partWords;
  }

  // --- Category bundles (filtered slices of the same content) ---
  const jackItems = [];
  const meetGreetItems = [];
  const optJournalItems = [];
  const notJackItems = [];
  for (const it of allExtracted) {
    const isJack = (it.stats.jackPosts > 0) || (it.thread.sources || []).includes('pinned');
    const sf = (it.thread.subforum || it.stats.subforum || '').trim();
    if (isJack) jackItems.push(it);
    else if (/^Meet and Greet$/i.test(sf)) meetGreetItems.push(it);
    else if (sf === 'My Optimal Journal') optJournalItems.push(it);
    else notJackItems.push(it);
  }
  await writeCategoryBundles({ label: 'jack-threads', title: 'Threads Jack participated in', items: jackItems, scrapedAt, totalThreadsOverall: allExtracted.length });
  await writeCategoryBundles({ label: 'meet-and-greet-threads', title: 'Meet and Greet subforum (no Jack posts)', items: meetGreetItems, scrapedAt, totalThreadsOverall: allExtracted.length });
  await writeCategoryBundles({ label: 'optimal-journal-threads', title: 'My Optimal Journal subforum (no Jack posts)', items: optJournalItems, scrapedAt, totalThreadsOverall: allExtracted.length });
  await writeCategoryBundles({ label: 'not-jack-threads', title: 'Threads Jack did NOT post in (excluding M&G and Optimal Journal)', items: notJackItems, scrapedAt, totalThreadsOverall: allExtracted.length });

  // --- xlsx index: one row per thread in threads.json universe ---
  const rows = universe
    .slice()
    .sort((a, b) => {
      const sa = idToStats.get(a.id);
      const sb = idToStats.get(b.id);
      const ya = sa?.firstDate || 'zzzz';
      const yb = sb?.firstDate || 'zzzz';
      if (ya !== yb) return ya.localeCompare(yb);
      return (a.id || 0) - (b.id || 0);
    })
    .map((t) => {
      const s = idToStats.get(t.id);
      const inMd = t.extracted && s ? 'yes' : 'no';
      const stem = threadFilenameStem(t.url);
      const threadFile = (t.extracted && stem) ? `${stem}.md` : '';
      const bundleFile = idToBundleFile.get(t.id) || '';
      const isJack = (s?.jackPosts > 0) || (t.sources || []).includes('pinned');
      const subforumName = (t.subforum || s?.subforum || '').trim();
      const category = !t.extracted ? ''
        : isJack ? 'jack'
        : /^Meet and Greet$/i.test(subforumName) ? 'meet-and-greet'
        : subforumName === 'My Optimal Journal' ? 'optimal-journal'
        : 'not-jack';
      return {
        in_md: inMd,
        category,
        bundle_file: bundleFile,
        thread_file: threadFile,
        id: t.id,
        title: t.title || s?.title || '',
        subforum: t.subforum || s?.subforum || '',
        sources: (t.sources || []).join(','),
        year: s?.firstDate ? Number(s.firstDate.slice(0, 4)) : '',
        first_post_date: s?.firstDate || '',
        last_post_date: s?.lastDate || '',
        post_count: s ? s.postCount : (t.extracted_post_count || ''),
        word_count: s ? s.wordCount : '',
        jack_post_count: s ? s.jackPosts : '',
        unique_authors: s ? s.uniqueAuthors : '',
        extracted_at: t.extracted_at || '',
        extracted_run_id: t.extracted_run_id || '',
        url: t.url,
        keywords: '',
      };
    });

  const headers = ['in_md', 'category', 'bundle_file', 'thread_file', 'id', 'title', 'subforum', 'sources', 'year', 'first_post_date', 'last_post_date', 'post_count', 'word_count', 'jack_post_count', 'unique_authors', 'extracted_at', 'extracted_run_id', 'url', 'keywords'];
  const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
  ws['!cols'] = [
    { wch: 6 }, { wch: 9 }, { wch: 16 }, { wch: 44 },
    { wch: 8 }, { wch: 60 }, { wch: 30 }, { wch: 30 },
    { wch: 6 }, { wch: 22 }, { wch: 22 },
    { wch: 6 }, { wch: 9 }, { wch: 6 }, { wch: 6 },
    { wch: 22 }, { wch: 36 }, { wch: 80 }, { wch: 40 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Threads');

  // Summary sheet
  const summary = [];
  for (const ex of ['yes', 'no']) {
    const subset = rows.filter((r) => r.in_md === ex);
    summary.push({
      group: `in_md=${ex}`,
      threads: subset.length,
      total_posts: subset.reduce((a, r) => a + (Number(r.post_count) || 0), 0),
      total_words: subset.reduce((a, r) => a + (Number(r.word_count) || 0), 0),
      jack_posts: subset.reduce((a, r) => a + (Number(r.jack_post_count) || 0), 0),
    });
  }
  for (const cat of ['jack', 'meet-and-greet', 'optimal-journal', 'not-jack']) {
    const subset = rows.filter((r) => r.category === cat);
    summary.push({
      group: `category=${cat}`,
      threads: subset.length,
      total_posts: subset.reduce((a, r) => a + (Number(r.post_count) || 0), 0),
      total_words: subset.reduce((a, r) => a + (Number(r.word_count) || 0), 0),
      jack_posts: subset.reduce((a, r) => a + (Number(r.jack_post_count) || 0), 0),
    });
  }
  summary.push({
    group: '— forum#N parts —',
    threads: partsWritten,
    total_posts: '',
    total_words: totalWordsWritten,
    jack_posts: '',
  });
  const ws2 = XLSX.utils.json_to_sheet(summary, { header: ['group', 'threads', 'total_posts', 'total_words', 'jack_posts'] });
  ws2['!cols'] = [{ wch: 32 }, { wch: 10 }, { wch: 14 }, { wch: 16 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, ws2, 'Summary');

  const xlsxPath = path.join(OUTPUT_DIR, 'forum-jackkruse-index.xlsx');
  XLSX.writeFile(wb, xlsxPath);
  info(`-> Excel: ${path.relative(PROJECT_ROOT, xlsxPath)} (${rows.length} rows)`);
  info(`-> ${partsWritten} forum#N.md parts written (${totalWordsWritten.toLocaleString()} words total)`);
  await stopProgressLog('END', { partsWritten, totalWords: totalWordsWritten, xlsxRows: rows.length });
}

// --- Pack chronological items into forum#N parts under caps ---

function packIntoParts(items) {
  const totalWords = items.reduce((a, it) => a + it.stats.wordCount, 0);
  info(`Packing ${items.length} threads (${totalWords.toLocaleString()} words) into NotebookLM-sized parts (≤${MAX_WORDS_PER_FILE.toLocaleString()} words / ≤${(MAX_BYTES_PER_FILE / 1024 / 1024).toFixed(0)} MB each, no file-count cap)`);

  const parts = [];
  let cur = [];
  let curWords = 0;
  let curBytes = 0;
  for (const it of items) {
    const itemBytes = Buffer.byteLength(it.stats.md, 'utf-8') + 1;
    const wouldExceedWords = curWords + it.stats.wordCount > MAX_WORDS_PER_FILE;
    const wouldExceedBytes = curBytes + itemBytes > MAX_BYTES_PER_FILE;
    if ((wouldExceedWords || wouldExceedBytes) && cur.length > 0) {
      parts.push(cur);
      cur = [];
      curWords = 0;
      curBytes = 0;
    }
    cur.push(it);
    curWords += it.stats.wordCount;
    curBytes += itemBytes;
  }
  if (cur.length > 0) parts.push(cur);
  return parts;
}

// Pack a filtered category and write its bundle files (single file if it fits
// in one part, otherwise <label>-1.md, <label>-2.md, ...).
async function writeCategoryBundles({ label, title, items, scrapedAt, totalThreadsOverall }) {
  if (items.length === 0) return;
  const parts = packIntoParts(items);
  for (let i = 0; i < parts.length; i++) {
    const partItems = parts[i];
    const partWords = partItems.reduce((a, it) => a + it.stats.wordCount, 0);
    const name = parts.length === 1 ? `${label}.md` : `${label}-${i + 1}.md`;
    const outPath = path.join(OUTPUT_DIR, name);
    await writePartFile({
      outPath,
      partItems,
      partIndex: i + 1,
      totalParts: parts.length,
      partWords,
      scrapedAt,
      totalThreadsOverall,
      heading: title,
    });
    const { size } = await stat(outPath);
    info(`  ${name}: ${partItems.length} threads, ${partWords.toLocaleString()} words, ${(size / 1024 / 1024).toFixed(2)} MB`);
  }
}

async function writePartFile({ outPath, partItems, partIndex, totalParts, partWords, scrapedAt, totalThreadsOverall, heading }) {
  const totalPosts = partItems.reduce((a, it) => a + it.stats.postCount, 0);
  const firstDate = partItems[0]?.stats.firstDate || '';
  const lastDate = partItems[partItems.length - 1]?.stats.firstDate || '';
  const subforums = [...new Set(partItems.map((it) => it.thread.subforum || it.stats.subforum).filter(Boolean))].sort();
  const yaml = [
    '---',
    'slug: jackkruse-forum',
    'site: forum.jackkruse.com',
    `part: ${partIndex}`,
    `total_parts: ${totalParts}`,
    `scraped_at: ${scrapedAt}`,
    `total_threads_in_part: ${partItems.length}`,
    `total_threads_overall: ${totalThreadsOverall}`,
    `total_posts_in_part: ${totalPosts}`,
    `total_words_in_part: ${partWords}`,
    `first_thread_date: ${firstDate}`,
    `last_thread_date: ${lastDate}`,
    `subforums_in_part: ${JSON.stringify(subforums)}`,
    '---',
    '',
    `# Jack Kruse Optimal Health Forum — ${heading || `forum#${partIndex} of ${totalParts}`}`,
    '',
    `**Source:** <${FORUM_BASE_URL}/>`,
    '',
    `Chronological slice (by first-post date) of every thread we extracted from forum.jackkruse.com. This is part ${partIndex} of ${totalParts}; covers threads first posted between **${firstDate}** and **${lastDate}**. Each thread is bounded by a \`═══...\` separator, posts as \`### <Author> — <Date>\` subsections with permalinks. Sized under NotebookLM source limits (≤450k words / ≤190 MB).`,
    '',
  ].join('\n');

  // Stream-write to avoid loading big buffer
  const ws = createWriteStream(outPath, { encoding: 'utf-8' });
  ws.write(yaml);
  for (const it of partItems) {
    ws.write(it.stats.md);
    ws.write('\n');
  }
  await new Promise((resolve, reject) => ws.end((err) => err ? reject(err) : resolve()));
}

// --- Parsing per-thread MD ---

function parseThreadStats(md) {
  const titleM = md.match(/^# Thread: (.+)$/m);
  const urlM = md.match(/\*\*Thread URL:\*\* <([^>]+)>/);
  const subM = md.match(/\*\*Subforum:\*\* (.+)$/m);
  const postRe = /^### (.+?) — (\S+)$/gm;
  const authors = new Set();
  let jackCount = 0;
  let postCount = 0;
  const dates = [];
  let m;
  while ((m = postRe.exec(md)) !== null) {
    const author = m[1].trim();
    const date = m[2].trim();
    authors.add(author);
    if (author === 'Jack Kruse') jackCount++;
    if (/^\d{4}-\d{2}-\d{2}/.test(date)) dates.push(date);
    postCount++;
  }
  dates.sort();
  // Word count = whitespace-delimited tokens. Cheap and consistent with how
  // NotebookLM counts.
  const wordCount = (md.match(/\S+/g) || []).length;
  return {
    title: titleM ? titleM[1].trim() : null,
    url: urlM ? urlM[1].trim() : null,
    subforum: subM ? subM[1].trim() : null,
    postCount,
    jackPosts: jackCount,
    uniqueAuthors: authors.size,
    firstDate: dates[0] || null,
    lastDate: dates[dates.length - 1] || null,
    wordCount,
  };
}

// --- Migration: rename legacy <id>.md → <slug>.<id>.md ---

async function renameLegacyThreadFiles(universe) {
  let dirEntries;
  try {
    dirEntries = await readdir(THREADS_DIR);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  const legacy = dirEntries.filter((n) => LEGACY_THREAD_FILE_RE.test(n));
  if (legacy.length === 0) return;
  const idToUrl = new Map(universe.map((t) => [t.id, t.url]));
  let renamed = 0, skipped = 0;
  for (const f of legacy) {
    const id = Number(f.replace(/\.md$/, ''));
    const url = idToUrl.get(id);
    if (!url) { skipped++; continue; }
    const stem = threadFilenameStem(url);
    if (!stem) { skipped++; continue; }
    const newName = `${stem}.md`;
    if (newName === f) continue;
    const oldPath = path.join(THREADS_DIR, f);
    const newPath = path.join(THREADS_DIR, newName);
    if (existsSync(newPath)) { skipped++; continue; }
    await rename(oldPath, newPath);
    renamed++;
  }
  if (renamed > 0) info(`Renamed ${renamed} legacy per-thread files to <slug>.<id>.md (skipped ${skipped})`);
}

// --- Migration: explode legacy year MDs / master MD into per-thread files ---

async function migrateLegacyMdsIfNeeded(universe) {
  let threadsDirEmpty = false;
  try {
    const existing = (await readdir(THREADS_DIR)).filter((n) => PER_THREAD_FILE_RE.test(n) || LEGACY_THREAD_FILE_RE.test(n));
    threadsDirEmpty = existing.length === 0;
  } catch (e) {
    if (e.code === 'ENOENT') threadsDirEmpty = true;
    else throw e;
  }
  if (!threadsDirEmpty) return;

  const entries = await readdir(OUTPUT_DIR);
  const legacy = entries.filter((n) => LEGACY_BUNDLE_PATTERNS.some((re) => re.test(n)));
  if (legacy.length === 0) return;
  info(`Migrating ${legacy.length} legacy MDs → per-thread files in ${path.relative(PROJECT_ROOT, THREADS_DIR)}`);
  await mkdir(THREADS_DIR, { recursive: true });

  let wrote = 0;
  for (const f of legacy) {
    const text = await readFile(path.join(OUTPUT_DIR, f), 'utf-8');
    const parts = text.split(`\n${THREAD_SEPARATOR}\n`);
    for (let i = 1; i + 1 < parts.length; i += 2) {
      const headerBlock = parts[i];
      const body = parts[i + 1];
      const urlM = headerBlock.match(/\*\*Thread URL:\*\* <([^>]+)>/);
      if (!urlM) continue;
      const stem = threadFilenameStem(urlM[1]);
      const idM = urlM[1].match(/\/threads\/[^/]+?\.(\d+)\/?/);
      if (!idM) continue;
      const id = Number(idM[1]);
      const filename = stem ? `${stem}.md` : `${id}.md`;
      const out = path.join(THREADS_DIR, filename);
      const threadMd = `${THREAD_SEPARATOR}\n${headerBlock}\n${THREAD_SEPARATOR}\n${body}`;
      await writeFile(out, threadMd, 'utf-8');
      wrote++;
    }
  }
  info(`  migrated ${wrote} threads`);
}
