import { readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  SCREEN_NAME,
  MAX_BUNDLE_BYTES,
  MAX_BUNDLE_WORDS,
} from '../settings.js';
import {
  readThreads,
  OUTPUT_DIR,
  THREADS_DIR,
  PROJECT_ROOT,
} from './storage.js';
import { info, warn, error, section } from './logger.js';

export async function runBundle() {
  section('NotebookLM bundle stage');
  const threads = await readThreads();
  const extracted = threads.filter((t) => t.extracted);
  if (extracted.length === 0) {
    error('No extracted threads found. Run extract first.');
    process.exit(1);
  }

  await deletePriorBundles();

  const items = [];
  for (const thread of extracted.sort((a, b) => Number(b.published_ts || 0) - Number(a.published_ts || 0))) {
    const file = path.join(THREADS_DIR, `${thread.id}.md`);
    if (!existsSync(file)) {
      warn(`thread=${thread.id} marked extracted but missing ${path.basename(file)}`);
      continue;
    }
    const md = await readFile(file, 'utf-8');
    const item = renderItem(thread, file, md);
    items.push({
      thread,
      content: item,
      bytes: Buffer.byteLength(item, 'utf-8'),
      words: countWords(item),
    });
  }

  const parts = [];
  let current = [];
  let currentBytes = headerForPart(1, 1, items.length).bytes;
  let currentWords = 0;
  for (const item of items) {
    if (current.length > 0 && (currentBytes + item.bytes > MAX_BUNDLE_BYTES || currentWords + item.words > MAX_BUNDLE_WORDS)) {
      parts.push(current);
      current = [];
      currentBytes = headerForPart(parts.length + 1, 1, items.length).bytes;
      currentWords = 0;
    }
    current.push(item);
    currentBytes += item.bytes;
    currentWords += item.words;
  }
  if (current.length > 0) parts.push(current);

  const totalParts = parts.length;
  for (let i = 0; i < parts.length; i++) {
    const partNo = i + 1;
    const outName = totalParts === 1 ? 'tweet-threads.md' : `tweet-threads-${partNo}.md`;
    const header = headerForPart(partNo, totalParts, items.length).text;
    const doc = header + parts[i].map((item) => item.content).join('\n\n') + '\n';
    await writeFile(path.join(OUTPUT_DIR, outName), doc, 'utf-8');
    info(`  ${outName}: ${parts[i].length} threads, ${countWords(doc)} words, ${(Buffer.byteLength(doc, 'utf-8') / 1024 / 1024).toFixed(2)} MB`);
  }

  info(`-> ${totalParts} NotebookLM tweet-thread bundle file${totalParts === 1 ? '' : 's'} written`);
}

function renderItem(thread, file, md) {
  const rel = path.relative(PROJECT_ROOT, file).replace(/\\/g, '/');
  return [
    '---',
    `thread_file: ${JSON.stringify(rel)}`,
    `thread_id: ${thread.id}`,
    '---',
    '',
    md.trim(),
    '',
  ].join('\n');
}

function headerForPart(partNo, totalParts, totalThreads) {
  const text = [
    '---',
    `slug: threadreader-${SCREEN_NAME.toLowerCase()}-tweet-threads`,
    'site: threadreaderapp.com',
    `screen_name: ${SCREEN_NAME}`,
    `slice: ${totalParts === 1 ? 'all' : `part ${partNo} of ${totalParts}`}`,
    `scraped_at: ${new Date().toISOString()}`,
    `total_threads: ${totalThreads}`,
    'notebooklm_limits: max 200MB and 500000 words per source; generated below 190MB and 490000 words',
    'media_policy: text-only; images, embedded players, and media URLs stripped',
    '---',
    '',
    `# @${SCREEN_NAME} Thread Reader Archive${totalParts === 1 ? '' : ` - part ${partNo} of ${totalParts}`}`,
    '',
    `**Source:** <https://threadreaderapp.com/user/${SCREEN_NAME}>`,
    '',
    'Text-only NotebookLM source assembled from Thread Reader App unrolled tweet threads. Each thread and tweet keeps source links.',
    '',
  ].join('\n');
  return { text, bytes: Buffer.byteLength(text, 'utf-8') };
}

function countWords(text) {
  const words = String(text).trim().match(/\S+/g);
  return words ? words.length : 0;
}

async function deletePriorBundles() {
  let entries;
  try {
    entries = await readdir(OUTPUT_DIR);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const name of entries) {
    if (/^tweet-threads(?:-\d+)?\.md$/.test(name)) {
      await unlink(path.join(OUTPUT_DIR, name));
    }
  }
}
