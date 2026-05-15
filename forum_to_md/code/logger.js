// Logger — mirrors every message to console AND a timestamped file under logs/.
// Copied from website_to_md/code/logger.js (same shape).

import { mkdirSync, existsSync, appendFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(__filename), '..');

let logFilePath = null;
let verbose = false;

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

// Console only. Detail lines (per-fetch, per-thread) NOT written to disk
// anymore — user explicitly asked for a single progress log with only every-
// 30-min rows + key events. progress-log.js handles the persistent log.
function writeLine(line) {
  console.log(line);
}

export function initLogger({ logsDir = 'logs', slug = 'run', runStamp = new Date().toISOString().replace(/[:.]/g, '-'), verbose: v = false } = {}) {
  verbose = v;
  const dir = path.join(PROJECT_ROOT, logsDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  logFilePath = path.join(dir, `forum-to-md.log`);
  writeLine(`========== LOG START ${new Date().toISOString()} stage=${slug} pid=${process.pid} ==========`);
  return logFilePath;
}

// Each line carries pid so parallel processes' lines stay disambiguatable.
const PID = process.pid;
export function log(msg) { writeLine(`[${ts()}][${PID}] ${msg}`); }
export function warn(msg) { writeLine(`[${ts()}][${PID}] ⚠️  ${msg}`); }
export function error(msg) { writeLine(`[${ts()}][${PID}] ❌ ${msg}`); }
export function info(msg) { writeLine(`[${ts()}][${PID}] ${msg}`); }
export function debug(msg) { writeLine(`[${ts()}][${PID}]   🐛 ${msg}`); }
export function trace(msg) { if (verbose) writeLine(`[${ts()}][${PID}]     🔬 ${msg}`); }
export function section(title) {
  writeLine('');
  writeLine(`────── ${title} ──────`);
}
export function getLogFilePath() { return logFilePath; }
