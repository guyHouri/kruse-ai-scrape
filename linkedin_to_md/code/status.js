import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const ARTICLES_JSON_PATH = path.join(PROJECT_ROOT, 'articles.json');
const ARTICLES_DIR = path.join(PROJECT_ROOT, 'processed_mds', 'articles');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'processed_mds');
const PROGRESS_LOG = path.join(PROJECT_ROOT, 'logs', 'progress.log');

export async function runStatus() {
  console.log('\n=== linkedin_to_md status ===\n');
  if (existsSync(ARTICLES_JSON_PATH)) {
    const a = JSON.parse(await readFile(ARTICLES_JSON_PATH, 'utf-8'));
    const ok = a.filter((x) => x.extracted).length;
    console.log(`articles.json: ${a.length} total, ${ok} extracted, ${a.length - ok} pending`);
  } else {
    console.log('articles.json: (not found)');
  }
  if (existsSync(ARTICLES_DIR)) {
    const f = (await readdir(ARTICLES_DIR)).filter((n) => n.endsWith('.md'));
    console.log(`per-article MDs: ${f.length} files`);
  }
  if (existsSync(OUTPUT_DIR)) {
    const b = (await readdir(OUTPUT_DIR)).filter((n) => /^linkedin#\d+\.md$/.test(n));
    console.log(`bundle MDs: ${b.length} files`);
  }
  try {
    const ps = execSync('powershell -Command "Get-Process node -ErrorAction SilentlyContinue | Select-Object Id,CPU | ConvertTo-Json -Compress"', { encoding: 'utf-8' });
    const procs = ps.trim() ? (JSON.parse(ps) instanceof Array ? JSON.parse(ps) : [JSON.parse(ps)]) : [];
    console.log(`live node procs: ${procs.length}`);
    for (const p of procs) console.log(`  pid=${p.Id} cpu=${Math.round(p.CPU || 0)}s`);
  } catch {}
  if (existsSync(PROGRESS_LOG)) {
    const lines = (await readFile(PROGRESS_LOG, 'utf-8')).trim().split('\n').slice(-5);
    console.log('\nlast 5 progress events:');
    for (const l of lines) console.log('  ' + l);
  }
  console.log('');
}
