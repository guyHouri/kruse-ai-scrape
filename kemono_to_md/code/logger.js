import { mkdirSync, existsSync, appendFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(__filename), '..');

let logFilePath = null;

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function writeLine(line) {
  console.log(line);
  if (!logFilePath) return;
  try {
    appendFileSync(logFilePath, line + '\n');
  } catch (_) {}
}

export function initLogger({ logsDir = 'logs', slug = 'run', runStamp = new Date().toISOString().replace(/[:.]/g, '-') } = {}) {
  const dir = path.join(PROJECT_ROOT, logsDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  logFilePath = path.join(dir, `${slug}_${runStamp}.log`);
  writeLine(`========== LOG START ${new Date().toISOString()} ==========`);
  writeLine(`Log file: ${logFilePath}`);
  return logFilePath;
}

export function info(msg) {
  writeLine(`[${ts()}] ${msg}`);
}

export function warn(msg) {
  writeLine(`[${ts()}] WARN ${msg}`);
}

export function error(msg) {
  writeLine(`[${ts()}] ERROR ${msg}`);
}

export function debug(msg) {
  writeLine(`[${ts()}]   ${msg}`);
}

export function section(title) {
  writeLine('');
  writeLine(`------ ${title} ------`);
}
