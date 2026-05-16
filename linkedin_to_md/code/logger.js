// Console-only logger. Persistent records go to progress-log.js → logs/progress.log + logs/workers.log.
function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}
const PID = process.pid;
function writeLine(line) { console.log(line); }
export function initLogger() { writeLine(`========== LOG START ${new Date().toISOString()} pid=${PID} ==========`); }
export function log(msg) { writeLine(`[${ts()}][${PID}] ${msg}`); }
export function warn(msg) { writeLine(`[${ts()}][${PID}] ⚠️  ${msg}`); }
export function error(msg) { writeLine(`[${ts()}][${PID}] ❌ ${msg}`); }
export function info(msg) { writeLine(`[${ts()}][${PID}] ${msg}`); }
export function debug(msg) { writeLine(`[${ts()}][${PID}]   🐛 ${msg}`); }
export function section(title) { writeLine(''); writeLine(`────── ${title} ──────`); }
