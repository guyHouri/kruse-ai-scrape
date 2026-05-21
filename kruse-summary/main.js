// Orchestrator. Default flow:
//   1. Decide which date the report covers (yesterday UTC).
//   2. Check if today's send already happened — exit if so.
//   3. Hit sunrise API; check we're inside the [target - tolerance, target + tolerance] window.
//   4. Build HTML.
//   5. Send via Gmail.
//   6. Mark state.
//
// Flags:
//   --build-only       build HTML, write to out/<date>.html, do NOT send
//   --force            skip sunrise window check AND last-sent check
//   --date=YYYY-MM-DD  override which date to report on (default = yesterday UTC)
//   --send-v2-test     pipeline smoke test: email the static kruse-summary-v2 HTML
//                      (skips scrape, build, sunrise gate, idempotency).

import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initLogger, info, warn, error } from './code/logger.js';
import { buildReportHtml } from './code/build-report.js';
import { checkSendWindow } from './code/sunrise.js';
import { sendReportEmail } from './code/email.js';
import { alreadySent, markSent } from './code/state.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

function yesterdayUtc() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (n) => {
    const hit = args.find((a) => a.startsWith(`--${n}=`));
    return hit ? hit.split('=')[1] : null;
  };
  return {
    buildOnly: args.includes('--build-only'),
    force: args.includes('--force'),
    sendV2Test: args.includes('--send-v2-test'),
    date: get('date'),
  };
}

function formatDdMmYyyy(date) {
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
}

// Find the most recent kruse-summary-v2-*.html file in the package root.
// User keeps these as hand-authored reference reports. We use the newest one
// as the pipeline smoke-test payload until the AI summarizer is wired in.
function findLatestV2Html() {
  const files = readdirSync(ROOT)
    .filter((f) => /^kruse-summary-v2.*\.html$/i.test(f))
    .map((f) => path.join(ROOT, f));
  if (!files.length) throw new Error('No kruse-summary-v2*.html file found in package root');
  files.sort();
  return files[files.length - 1];
}

async function runSendV2Test() {
  const file = findLatestV2Html();
  const html = readFileSync(file, 'utf8');
  info(`pipeline smoke test: emailing ${path.basename(file)} (${html.length} bytes)`);
  // Try to pull a DD/MM/YYYY out of the filename for the subject.
  const m = path.basename(file).match(/(\d{2}-\d{2}-\d{4})/);
  const dateDisplay = m ? m[1].replace(/-/g, '/') : new Date().toISOString().slice(0, 10);
  await sendReportEmail({
    subject: `[PIPELINE TEST] Daily Kruse Summary — ${dateDisplay}`,
    html,
    dateDisplay,
  });
  info('pipeline smoke test done.');
}

async function main() {
  initLogger({ slug: 'daily' });
  const args = parseArgs();

  if (args.sendV2Test) {
    await runSendV2Test();
    return;
  }

  const reportDate = args.date || yesterdayUtc();
  const dateDisplay = formatDdMmYyyy(reportDate);
  info(`reportDate=${reportDate} (yesterday UTC by default)`);

  if (!args.force && !args.buildOnly && alreadySent(reportDate)) {
    info(`already sent for ${reportDate} — exiting (use --force to override).`);
    return;
  }

  const html = buildReportHtml(reportDate);
  const outDir = path.join(ROOT, 'out');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${reportDate}.html`);
  writeFileSync(outPath, html, 'utf8');
  info(`wrote ${outPath} (${html.length} bytes)`);

  if (args.buildOnly) { info('build-only mode, skipping send.'); return; }

  if (!args.force) {
    const { inWindow, target } = await checkSendWindow();
    if (!inWindow) {
      info(`not in send window (target=${target.toISOString()}). Exiting.`);
      return;
    }
  } else {
    warn('--force: bypassing sunrise window check.');
  }

  await sendReportEmail({
    subject: `Daily Kruse Summary — ${dateDisplay}`,
    html,
    dateDisplay,
  });
  markSent(reportDate);
  info('done.');
}

main().catch((e) => {
  error(`crashed: ${e.stack || e.message}`);
  process.exit(1);
});
