// One-shot recovery: rebuild threads.json from per-thread MD files.
// Used after pinned discover overwrote threads.json. Merges any existing
// threads.json entries' source metadata.

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { info, error, section } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const THREADS_DIR = path.join(PROJECT_ROOT, 'processed_mds', 'threads');
const THREADS_JSON_PATH = path.join(PROJECT_ROOT, 'threads.json');

export async function runRecover() {
  section('Recover threads.json from per-thread MDs');

  // Load existing threads.json (may be partial after wipe)
  let existing = [];
  if (existsSync(THREADS_JSON_PATH)) {
    try {
      existing = JSON.parse(await readFile(THREADS_JSON_PATH, 'utf-8'));
    } catch {
      existing = [];
    }
  }
  const existingById = new Map(existing.map((t) => [t.id, t]));
  info(`Existing threads.json has ${existing.length} entries`);

  // Scan per-thread MDs
  const files = (await readdir(THREADS_DIR)).filter((n) => /\.\d+\.md$/.test(n) || /^\d+\.md$/.test(n));
  info(`Found ${files.length} per-thread MD files`);

  const now = new Date().toISOString();
  const recovered = [];
  for (const f of files) {
    const md = await readFile(path.join(THREADS_DIR, f), 'utf-8');
    const titleM = md.match(/^# Thread: (.+)$/m);
    const urlM = md.match(/\*\*Thread URL:\*\* <([^>]+)>/);
    const subM = md.match(/\*\*Subforum:\*\* (.+)$/m);
    const postCountM = md.match(/\*\*Posts:\*\* (\d+)/);
    if (!urlM) continue;
    const idM = urlM[1].match(/\/threads\/[^/]+?\.(\d+)\/?/);
    if (!idM) continue;
    const id = Number(idM[1]);
    const title = titleM ? titleM[1].trim() : null;
    const url = urlM[1].trim();
    const subforum = subM ? subM[1].trim() : null;
    const postCount = postCountM ? Number(postCountM[1]) : 0;
    // Detect Jack involvement
    const jackPosts = (md.match(/^### Jack Kruse — /gm) || []).length;

    // Merge with existing entry if present
    const existingEntry = existingById.get(id);
    const sourcesSet = new Set(existingEntry?.sources || []);
    // Default: 'recovered' (will be tagged pinned/jack-contributed by next discover runs)
    if (sourcesSet.size === 0) sourcesSet.add('recovered');
    if (jackPosts > 0) sourcesSet.add('jack-contributed');

    recovered.push({
      ...(existingEntry || {}),
      id,
      url,
      title,
      subforum,
      sources: [...sourcesSet].sort(),
      discovered_at: existingEntry?.discovered_at || now,
      extracted: true,
      extracted_at: existingEntry?.extracted_at || now,
      extracted_run_id: existingEntry?.extracted_run_id || `recover-${now}`,
      extracted_post_count: postCount,
    });
  }

  // Also keep any existing threads.json entries that don't have a per-thread MD
  // (e.g., discovered-but-not-yet-extracted)
  const recoveredIds = new Set(recovered.map((t) => t.id));
  for (const e of existing) {
    if (!recoveredIds.has(e.id)) {
      // Mark extracted=false since no per-thread MD on disk
      recovered.push({ ...e, extracted: false });
    }
  }

  recovered.sort((a, b) => (a.id || 0) - (b.id || 0));
  await writeFile(THREADS_JSON_PATH, JSON.stringify(recovered, null, 2) + '\n', 'utf-8');
  const withJack = recovered.filter((t) => (t.sources || []).includes('jack-contributed')).length;
  const recoveredOnly = recovered.filter((t) => (t.sources || []).includes('recovered')).length;
  const extracted = recovered.filter((t) => t.extracted).length;
  info(`-> threads.json now has ${recovered.length} entries`);
  info(`   with jack-contributed source: ${withJack}`);
  info(`   tagged 'recovered' (need pinned/jack-discover to re-tag): ${recoveredOnly}`);
  info(`   extracted=true: ${extracted}`);
}
