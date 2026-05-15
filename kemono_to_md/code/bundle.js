import { readFile, writeFile, readdir, unlink, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  BLOG_SERIES_DIR,
  OUTPUT_DIR,
  PROJECT_ROOT,
} from './storage.js';
import {
  classifyBlogSeries,
  relativePosix,
  sortBlogFiles,
} from './series-utils.js';
import { info, warn, error, section } from './logger.js';

const MAX_SOURCE_BYTES = 190 * 1024 * 1024;
const MAX_SOURCE_WORDS = 490000;

export async function runBundle() {
  section('NotebookLM blogs bundle stage');
  if (!existsSync(BLOG_SERIES_DIR)) {
    error(`blog_series folder not found at ${BLOG_SERIES_DIR}. Run npm run organize first.`);
    process.exit(1);
  }

  const files = await listBlogSeriesFiles(BLOG_SERIES_DIR);
  if (files.length === 0) {
    error(`No markdown files found in ${BLOG_SERIES_DIR}.`);
    process.exit(1);
  }

  await deletePriorBundles();

  const parts = [];
  let current = [];
  let currentBytes = headerForPart(1, 1, files.length).bytes;
  let currentWords = 0;

  for (const file of files) {
    const content = await readFile(file.fullPath, 'utf-8');
    const item = renderItem(file, content);
    const bytes = Buffer.byteLength(item, 'utf-8');
    const words = countWords(item);
    if (current.length > 0 && (currentBytes + bytes > MAX_SOURCE_BYTES || currentWords + words > MAX_SOURCE_WORDS)) {
      parts.push(current);
      current = [];
      currentBytes = headerForPart(parts.length + 1, 1, files.length).bytes;
      currentWords = 0;
    }
    current.push({ ...file, content: item, bytes, words });
    currentBytes += bytes;
    currentWords += words;
  }
  if (current.length > 0) parts.push(current);

  const totalParts = parts.length;
  for (let i = 0; i < parts.length; i++) {
    const partNo = i + 1;
    const outName = totalParts === 1 ? 'blogs.md' : `blogs-${partNo}.md`;
    const header = headerForPart(partNo, totalParts, files.length).text;
    const doc = header + parts[i].map((item) => item.content).join('\n\n') + '\n';
    const out = path.join(OUTPUT_DIR, outName);
    await writeFile(out, doc, 'utf-8');
    info(`  ${outName}: ${parts[i].length} docs, ${countWords(doc)} words, ${(Buffer.byteLength(doc, 'utf-8') / 1024 / 1024).toFixed(2)} MB`);
  }

  info(`-> ${totalParts} NotebookLM blog bundle file${totalParts === 1 ? '' : 's'} written`);
}

async function listBlogSeriesFiles(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await listBlogSeriesFiles(full));
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      const rel = relativePosix(BLOG_SERIES_DIR, full);
      const series = rel.split('/')[0] || 'OTHER';
      const classification = classifyBlogSeries(path.basename(entry.name, '.md'), full);
      const st = await stat(full);
      if (st.size === 0) {
        warn(`Skipping empty blog-series file: ${rel}`);
        continue;
      }
      out.push({
        fullPath: full,
        rel,
        name: entry.name,
        series,
        number: classification.number,
      });
    }
  }
  return out.sort(sortBlogFiles);
}

function renderItem(file, content) {
  return [
    '---',
    `blog_series_file: ${JSON.stringify(relativePosix(PROJECT_ROOT, file.fullPath))}`,
    `series: ${JSON.stringify(file.series)}`,
    '---',
    '',
    content.trim(),
    '',
  ].join('\n');
}

function headerForPart(partNo, totalParts, totalDocs) {
  const text = [
    '---',
    'slug: kemono-patreon-drjackkruse-blogs',
    'site: kemono.cr + local blog PDFs',
    `slice: ${totalParts === 1 ? 'all' : `part ${partNo} of ${totalParts}`}`,
    `scraped_at: ${new Date().toISOString()}`,
    `total_blog_documents: ${totalDocs}`,
    `notebooklm_limits: max 200MB and 500000 words per source; generated below 190MB and 490000 words`,
    'media_policy: text-only; attachments, previews, videos, media links, and PDF images excluded',
    '---',
    '',
    `# Dr. Jack Kruse Patreon / Blog Archive${totalParts === 1 ? '' : ` - part ${partNo} of ${totalParts}`}`,
    '',
    'Text-only NotebookLM source assembled from Kemono API article markdown and local blog PDF text conversions. Each article keeps its source URL or source PDF path.',
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
  const oldYearly = /^kemono-patreon-drjackkruse-(?:\d{4}|unknown)\.md$/;
  const oldBlogs = /^blogs(?:-\d+)?\.md$/;
  for (const name of entries) {
    if (oldYearly.test(name) || oldBlogs.test(name)) {
      await unlink(path.join(OUTPUT_DIR, name));
    }
  }
}
