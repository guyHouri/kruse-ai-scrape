import { readFile, writeFile, rename, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const THREADS_JSON_PATH = path.join(PROJECT_ROOT, 'threads.json');
export const OUTPUT_DIR = path.join(PROJECT_ROOT, 'processed_mds');
export const THREADS_DIR = path.join(OUTPUT_DIR, 'threads');

export async function ensureOutputDirs() {
  await mkdir(THREADS_DIR, { recursive: true });
}

export async function readThreads() {
  if (!existsSync(THREADS_JSON_PATH)) return [];
  const parsed = JSON.parse(await readFile(THREADS_JSON_PATH, 'utf-8'));
  if (!Array.isArray(parsed)) throw new Error('threads.json is not an array');
  for (const t of parsed) {
    t.id = String(t.id);
    if (t.extracted === undefined) t.extracted = false;
  }
  return parsed;
}

export async function persistThreads(localThreads) {
  let current = [];
  try {
    current = await readThreads();
  } catch {
    current = [];
  }

  const localById = new Map(localThreads.map((t) => [String(t.id), t]));
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
    merged.push({
      ...fileEntry,
      ...local,
      extracted: local.extracted || !!fileEntry.extracted,
      extracted_at: local.extracted_at || fileEntry.extracted_at || undefined,
      extracted_run_id: local.extracted_run_id || fileEntry.extracted_run_id || undefined,
      tweet_count: local.tweet_count !== undefined ? local.tweet_count : fileEntry.tweet_count,
      word_count: local.word_count !== undefined ? local.word_count : fileEntry.word_count,
    });
  }

  for (const local of localThreads) {
    const id = String(local.id);
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(local);
  }

  merged.sort((a, b) => {
    const timeCmp = Number(b.published_ts || 0) - Number(a.published_ts || 0);
    return timeCmp !== 0 ? timeCmp : String(b.id).localeCompare(String(a.id));
  });

  const tmp = `${THREADS_JSON_PATH}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rename(tmp, THREADS_JSON_PATH);
      return merged;
    } catch (err) {
      if (err.code !== 'EPERM' && err.code !== 'EBUSY') throw err;
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 200));
    }
  }
  throw new Error('persistThreads: rename gave up after 10 retries');
}

export async function listThreadMarkdownFiles() {
  await ensureOutputDirs();
  const entries = await readdir(THREADS_DIR);
  return entries.filter((name) => /^\d+\.md$/.test(name));
}
