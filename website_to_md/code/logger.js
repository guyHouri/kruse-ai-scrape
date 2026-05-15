// Logger — mirrors every message to console AND a timestamped file under logs/.
// Adapted from facebook_group_to_md/code/logger.js (same shape, no Playwright
// hooks). Writing to disk gives Claude something to post-mortem after a crash,
// instead of relying on console output that scrolled past or got truncated.

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

function writeLine(line) {
  console.log(line);
  if (logFilePath) {
    try {
      appendFileSync(logFilePath, line + '\n');
    } catch (_) {}
  }
}

// Call once at startup. `logsDir` is relative to PROJECT_ROOT.
export function initLogger({ logsDir = 'logs', slug = 'run', runStamp = new Date().toISOString().replace(/[:.]/g, '-'), verbose: v = false } = {}) {
  verbose = v;
  const dir = path.join(PROJECT_ROOT, logsDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  logFilePath = path.join(dir, `${slug}_${runStamp}.log`);
  writeLine(`========== LOG START ${new Date().toISOString()} ==========`);
  writeLine(`Log file: ${logFilePath}`);
  return logFilePath;
}

export function log(msg) {
  writeLine(`[${ts()}] ${msg}`);
}

export function warn(msg) {
  writeLine(`[${ts()}] ⚠️  ${msg}`);
}

export function error(msg) {
  writeLine(`[${ts()}] ❌ ${msg}`);
}

// Info — short, user-friendly. Always on.
export function info(msg) {
  writeLine(`[${ts()}] ${msg}`);
}

// Debug — more detail. Always on by default while the pipeline is in
// debugging phase. Flip off via initLogger({ verbose: false }) once stable.
export function debug(msg) {
  writeLine(`[${ts()}]   🐛 ${msg}`);
}

// Trace — very verbose (per-link rejection counts, etc). Gated by verbose flag.
export function trace(msg) {
  if (!verbose) return;
  writeLine(`[${ts()}]     🔬 ${msg}`);
}

// Section divider — helps skimming the log file.
export function section(title) {
  writeLine('');
  writeLine(`────── ${title} ──────`);
}

export function getLogFilePath() {
  return logFilePath;
}
