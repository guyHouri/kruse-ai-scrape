import { readFile, writeFile, rename, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const ARTICLES_JSON_PATH = path.join(PROJECT_ROOT, 'articles.json');
export const OUTPUT_DIR = path.join(PROJECT_ROOT, 'processed_mds');
export const ARTICLES_DIR = path.join(OUTPUT_DIR, 'articles');
export const BLOG_SERIES_DIR = path.join(OUTPUT_DIR, 'blog_series');
export const BLOG_PDF_DIR = path.join(OUTPUT_DIR, 'blog');

export async function ensureOutputDirs() {
  await mkdir(ARTICLES_DIR, { recursive: true });
}

export async function readArticles() {
  if (!existsSync(ARTICLES_JSON_PATH)) return [];
  const parsed = JSON.parse(await readFile(ARTICLES_JSON_PATH, 'utf-8'));
  if (!Array.isArray(parsed)) throw new Error('articles.json is not an array');
  for (const a of parsed) {
    a.id = String(a.id);
    if (!Array.isArray(a.sources)) a.sources = a.source ? [a.source] : ['kemono-api'];
    delete a.source;
    if (a.extracted === undefined) a.extracted = false;
  }
  return parsed;
}

export async function persistArticles(localArticles) {
  let current = [];
  try {
    current = await readArticles();
  } catch {
    current = [];
  }

  const localById = new Map(localArticles.map((a) => [String(a.id), a]));
  const merged = [];
  const seen = new Set();

  for (const fileEntry of current) {
    const id = String(fileEntry.id);
    if (seen.has(id)) continue;
    seen.add(id);
    const local = localById.get(id);
    if (!local) {
      merged.push(fileEntry);
      continue;
    }
    const unionSources = Array.from(new Set([...(fileEntry.sources || []), ...(local.sources || [])]));
    merged.push({
      ...fileEntry,
      ...local,
      sources: unionSources,
      extracted: local.extracted || !!fileEntry.extracted,
      extracted_at: local.extracted_at || fileEntry.extracted_at || undefined,
      extracted_run_id: local.extracted_run_id || fileEntry.extracted_run_id || undefined,
      text_chars: local.text_chars !== undefined ? local.text_chars : fileEntry.text_chars,
    });
  }

  for (const local of localArticles) {
    const id = String(local.id);
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(local);
  }

  merged.sort((a, b) => {
    const dateCmp = (b.published_at || b.added_at || '').localeCompare(a.published_at || a.added_at || '');
    return dateCmp !== 0 ? dateCmp : String(b.id).localeCompare(String(a.id));
  });

  const tmp = `${ARTICLES_JSON_PATH}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rename(tmp, ARTICLES_JSON_PATH);
      return merged;
    } catch (err) {
      if (err.code !== 'EPERM' && err.code !== 'EBUSY') throw err;
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 200));
    }
  }
  throw new Error('persistArticles: rename gave up after 10 retries');
}

export async function listArticleMarkdownFiles() {
  await ensureOutputDirs();
  const entries = await readdir(ARTICLES_DIR);
  return entries.filter((name) => /^\d{4}-\d{2}-\d{2}-\d+\.md$|^unknown-\d+\.md$/.test(name));
}
