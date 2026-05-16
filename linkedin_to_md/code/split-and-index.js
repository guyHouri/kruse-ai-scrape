// Split stage: pack per-article MDs into linkedin#N.md bundles + xlsx index.
// Caps per file: <=490k words, <=195 MB (NotebookLM-safe). No file-count cap.

import { readFile, writeFile, mkdir, readdir, unlink, stat } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import { ARTICLE_SEPARATOR } from '../settings.js';
import { info, warn, error, section } from './logger.js';
import { startProgressLog, stopProgressLog } from './progress-log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'processed_mds');
const ARTICLES_DIR = path.join(OUTPUT_DIR, 'articles');
const ARTICLES_JSON_PATH = path.join(PROJECT_ROOT, 'articles.json');

const LINKEDIN_PART_RE = /^linkedin#\d+\.md$/;
const MAX_WORDS_PER_FILE = 490_000;
const MAX_BYTES_PER_FILE = 195 * 1024 * 1024;

export async function runSplit() {
  section('Split + Index stage');
  startProgressLog('split');

  let universe;
  try {
    universe = JSON.parse(await readFile(ARTICLES_JSON_PATH, 'utf-8'));
  } catch (e) {
    error(`Cannot read articles.json: ${e.message}`);
    process.exit(1);
  }
  info(`articles.json: ${universe.length} total, ${universe.filter(a => a.extracted).length} extracted`);

  await mkdir(ARTICLES_DIR, { recursive: true });
  const articleFiles = (await readdir(ARTICLES_DIR)).filter((n) => n.endsWith('.md'));
  const slugToMd = new Map();
  for (const f of articleFiles) {
    const md = await readFile(path.join(ARTICLES_DIR, f), 'utf-8');
    slugToMd.set(f.replace(/\.md$/, ''), md);
  }

  // Build extracted list, sorted by published date
  const items = [];
  for (const a of universe) {
    if (!a.extracted) continue;
    const md = slugToMd.get(a.slug);
    if (!md) { warn(`slug ${a.slug} extracted=true but no MD on disk`); continue; }
    const wordCount = (md.match(/\S+/g) || []).length;
    items.push({ article: a, md, wordCount });
  }
  items.sort((a, b) => (a.article.dateIso || 'zzzz').localeCompare(b.article.dateIso || 'zzzz'));

  // Clean prior bundles
  for (const n of await readdir(OUTPUT_DIR)) {
    if (LINKEDIN_PART_RE.test(n)) await unlink(path.join(OUTPUT_DIR, n));
  }

  // Pack
  const parts = [];
  let cur = [];
  let curWords = 0;
  let curBytes = 0;
  for (const it of items) {
    const itemBytes = Buffer.byteLength(it.md, 'utf-8') + 1;
    const wouldExceedWords = curWords + it.wordCount > MAX_WORDS_PER_FILE;
    const wouldExceedBytes = curBytes + itemBytes > MAX_BYTES_PER_FILE;
    if ((wouldExceedWords || wouldExceedBytes) && cur.length > 0) {
      parts.push(cur);
      cur = []; curWords = 0; curBytes = 0;
    }
    cur.push(it);
    curWords += it.wordCount;
    curBytes += itemBytes;
  }
  if (cur.length > 0) parts.push(cur);

  // Write parts
  const scrapedAt = new Date().toISOString();
  const idToBundle = new Map();
  for (let i = 0; i < parts.length; i++) {
    const partItems = parts[i];
    const partWords = partItems.reduce((a, it) => a + it.wordCount, 0);
    const name = `linkedin#${i + 1}.md`;
    const outPath = path.join(OUTPUT_DIR, name);
    const firstDate = partItems[0]?.article.dateIso || '';
    const lastDate = partItems[partItems.length - 1]?.article.dateIso || '';
    const yaml = [
      '---',
      'slug: jackkruse-linkedin',
      'site: linkedin.com/in/drjackkruse',
      `part: ${i + 1}`,
      `total_parts: ${parts.length}`,
      `scraped_at: ${scrapedAt}`,
      `total_articles_in_part: ${partItems.length}`,
      `total_words_in_part: ${partWords}`,
      `first_article_date: ${firstDate}`,
      `last_article_date: ${lastDate}`,
      '---',
      '',
      `# Dr. Jack Kruse — LinkedIn Pulse articles, part ${i + 1} of ${parts.length}`,
      '',
      `**Source:** <https://www.linkedin.com/in/drjackkruse/recent-activity/articles/>`,
      '',
      `Chronological slice (by published date) of Jack Kruse's LinkedIn articles. Part ${i + 1} of ${parts.length}; covers articles published between **${firstDate}** and **${lastDate}**.`,
      '',
    ].join('\n');
    const ws = createWriteStream(outPath, { encoding: 'utf-8' });
    ws.write(yaml);
    for (const it of partItems) { ws.write(it.md); ws.write('\n'); }
    await new Promise((resolve, reject) => ws.end((err) => err ? reject(err) : resolve()));
    const { size } = await stat(outPath);
    for (const it of partItems) idToBundle.set(it.article.canonical, name);
    info(`  ${name}: ${partItems.length} articles, ${partWords.toLocaleString()} words, ${(size / 1024 / 1024).toFixed(2)} MB`);
  }

  // xlsx index
  const rows = universe.slice().sort((a, b) => (a.dateIso || 'zzzz').localeCompare(b.dateIso || 'zzzz')).map((a) => ({
    in_md: a.extracted ? 'yes' : 'no',
    bundle_file: idToBundle.get(a.canonical) || '',
    article_file: a.slug ? `${a.slug}.md` : '',
    title: a.title || '',
    date: a.dateIso || '',
    word_count: a.word_count || '',
    sources: (a.sources || []).join(','),
    url: a.url,
  }));
  const headers = ['in_md', 'bundle_file', 'article_file', 'title', 'date', 'word_count', 'sources', 'url'];
  const wsx = XLSX.utils.json_to_sheet(rows, { header: headers });
  wsx['!cols'] = [{ wch: 6 }, { wch: 16 }, { wch: 60 }, { wch: 80 }, { wch: 12 }, { wch: 8 }, { wch: 24 }, { wch: 80 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsx, 'Articles');
  const xlsxOut = path.join(OUTPUT_DIR, 'linkedin-articles-index.xlsx');
  XLSX.writeFile(wb, xlsxOut);
  info(`-> Excel: ${path.relative(PROJECT_ROOT, xlsxOut)} (${rows.length} rows)`);
  info(`-> ${parts.length} linkedin#N.md parts written`);
  await stopProgressLog('END', { parts: parts.length, rows: rows.length });
}
