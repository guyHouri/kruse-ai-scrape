// Single shared logs/progress.log (30-min ticks) + logs/workers.log (1-min per worker).
import { appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const LOGS_DIR = path.join(PROJECT_ROOT, 'logs');
const PROGRESS_LOG = path.join(LOGS_DIR, 'progress.log');
const WORKERS_LOG = path.join(LOGS_DIR, 'workers.log');

const TICK_MS = 30 * 60 * 1000;
const WORKER_TICK_MS = 60 * 1000;

let timerId = null;
let workerTimerId = null;
let currentStage = null;
let workerStartTs = null;
let workerCounters = { articlesDone: 0, words: 0, failed: 0 };

export function startProgressLog(stageName) {
  currentStage = stageName;
  workerStartTs = Date.now();
  workerCounters = { articlesDone: 0, words: 0, failed: 0 };
  writeRow('START').catch(() => {});
  writeWorkerRow('TICK').catch(() => {});
  timerId = setInterval(() => writeRow('TICK').catch(() => {}), TICK_MS);
  workerTimerId = setInterval(() => writeWorkerRow('TICK').catch(() => {}), WORKER_TICK_MS);
  if (timerId.unref) timerId.unref();
  if (workerTimerId.unref) workerTimerId.unref();
}

export async function stopProgressLog(reason = 'END', extra = null) {
  if (timerId) { clearInterval(timerId); timerId = null; }
  if (workerTimerId) { clearInterval(workerTimerId); workerTimerId = null; }
  await writeWorkerRow(reason).catch(() => {});
  return writeRow(reason, extra).catch(() => {});
}

export function bumpWorker({ articlesDone = 0, words = 0, failed = 0 } = {}) {
  workerCounters.articlesDone += articlesDone;
  workerCounters.words += words;
  workerCounters.failed += failed;
}

async function writeRow(event, extra) {
  if (!existsSync(LOGS_DIR)) await mkdir(LOGS_DIR, { recursive: true });
  const ts = new Date().toISOString();
  const flat = extra ? Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(' ') : '';
  const line = `${ts} | ${event.padEnd(16)} | stage=${currentStage || '-'} | pid=${process.pid} | ${flat}`;
  try { await appendFile(PROGRESS_LOG, line + '\n', 'utf-8'); } catch {}
}

async function writeWorkerRow(event) {
  if (!existsSync(LOGS_DIR)) await mkdir(LOGS_DIR, { recursive: true });
  const ts = new Date().toISOString();
  const elapsed = workerStartTs ? Math.round((Date.now() - workerStartTs) / 1000) : 0;
  const line = `${ts} | ${event.padEnd(8)} | stage=${(currentStage || '-').padEnd(20)} | pid=${String(process.pid).padEnd(6)} | elapsed=${String(elapsed).padStart(6)}s | articles_done=${workerCounters.articlesDone} words=${workerCounters.words} failed=${workerCounters.failed}`;
  try { await appendFile(WORKERS_LOG, line + '\n', 'utf-8'); } catch {}
}
