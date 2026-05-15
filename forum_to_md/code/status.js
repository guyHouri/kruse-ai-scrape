// `npm run status` — prints current scrape state. Use this anytime to verify
// the pipeline is alive and progressing.

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const THREADS_JSON_PATH = path.join(PROJECT_ROOT, 'threads.json');
const THREADS_DIR = path.join(PROJECT_ROOT, 'processed_mds', 'threads');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'processed_mds');
const PROGRESS_LOG = path.join(PROJECT_ROOT, 'logs', 'progress.log');

export async function runStatus() {
  console.log('\n=== forum_to_md pipeline status ===\n');

  // threads.json
  if (existsSync(THREADS_JSON_PATH)) {
    const t = JSON.parse(await readFile(THREADS_JSON_PATH, 'utf-8'));
    const extracted = t.filter((x) => x.extracted).length;
    const pending = t.length - extracted;
    const jack = t.filter((x) => (x.sources || []).includes('jack-contributed')).length;
    const pinned = t.filter((x) => (x.sources || []).includes('pinned')).length;
    const subforum = t.filter((x) => (x.sources || []).includes('discovered-via-subforum')).length;
    console.log(`threads.json: ${t.length} total (extracted=${extracted}, pending=${pending})`);
    console.log(`  sources: pinned=${pinned}, jack-contributed=${jack}, via-subforum=${subforum}`);
  } else {
    console.log('threads.json: (not found)');
  }

  // Per-thread MD count + last-modified
  if (existsSync(THREADS_DIR)) {
    const files = (await readdir(THREADS_DIR)).filter((n) => n.endsWith('.md'));
    let newest = 0, newestName = '';
    for (const f of files.slice(-1000)) {  // sample last 1000 by alpha
      const s = await stat(path.join(THREADS_DIR, f));
      if (s.mtimeMs > newest) { newest = s.mtimeMs; newestName = f; }
    }
    const minutesAgo = newest ? Math.round((Date.now() - newest) / 60000) : null;
    console.log(`per-thread MDs: ${files.length} files`);
    if (newestName) console.log(`  newest: ${newestName} (${minutesAgo}min ago)`);
  }

  // Bundle files
  if (existsSync(OUTPUT_DIR)) {
    const bundles = (await readdir(OUTPUT_DIR)).filter((n) => /^forum-jackkruse-.*\.md$/.test(n) || /-threads\.md$/.test(n));
    console.log(`bundle MDs: ${bundles.length} files`);
  }

  // Live node procs
  try {
    const ps = execSync('powershell -Command "Get-Process node -ErrorAction SilentlyContinue | Select-Object Id,CPU | ConvertTo-Json -Compress"', { encoding: 'utf-8' });
    const procs = ps.trim() ? (JSON.parse(ps) instanceof Array ? JSON.parse(ps) : [JSON.parse(ps)]) : [];
    console.log(`live node processes: ${procs.length}`);
    for (const p of procs) console.log(`  pid=${p.Id} cpu=${Math.round(p.CPU || 0)}s`);
  } catch (e) {
    console.log('live node processes: (unable to query)');
  }

  // Last 5 progress rows
  if (existsSync(PROGRESS_LOG)) {
    const lines = (await readFile(PROGRESS_LOG, 'utf-8')).trim().split('\n').slice(-5);
    console.log('\nlast 5 progress events:');
    for (const l of lines) console.log('  ' + l);
  } else {
    console.log('\nno progress log yet (logs/progress.log not found)');
  }
  console.log('');
}
