// Minimal console logger. Mirrors forum_to_md/code/logger.js shape.

const PID = process.pid;
function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function line(msg) { console.log(`[${ts()}][${PID}] ${msg}`); }

export function initLogger({ slug = 'run' } = {}) {
  line(`========== twitter_to_md START stage=${slug} ==========`);
}
export function info(msg)  { line(msg); }
export function warn(msg)  { line(`⚠️  ${msg}`); }
export function error(msg) { line(`❌ ${msg}`); }
export function debug(msg) { line(`🐛 ${msg}`); }
