// Orchestrator. Default flow:
//   1. Decide which date the report covers (current REPORT_TIME_ZONE day by default).
//   2. Check if today's send already happened — exit if so.
//   3. Hit sunrise API; check we're inside the [target - tolerance, target + tolerance] window.
//   4. Build HTML.
//   5. Send via Gmail.
//   6. Mark state.
//
// Flags:
//   --build-only       build HTML, write to out/<date>.html, do NOT send
//   --force            skip sunrise window check AND last-sent check
//   --skip-window      skip sunrise window check, but still respect last-sent
//   --date=YYYY-MM-DD  override which date to report on

import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initLogger, info, warn, error } from './code/logger.js';
import { buildReportHtml } from './code/build-report.js';
import { checkSendWindow } from './code/sunrise.js';
import { sendReportEmail } from './code/email.js';
import { alreadySent, markSent } from './code/state.js';
import { summarizeDay } from './code/summarize.js';
import { SETTINGS } from './settings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

function todayInReportTimeZone() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SETTINGS.reportTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
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
    skipWindow: args.includes('--skip-window'),
    useAi: args.includes('--use-ai'),
    aiDryRun: args.includes('--ai-dry-run'),
    date: get('date'),
    summary: get('summary'),
  };
}

function formatDdMmYyyy(date) {
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
}

async function main() {
  initLogger({ slug: 'daily' });
  const args = parseArgs();

  const reportDate = args.date || todayInReportTimeZone();
  const dateDisplay = formatDdMmYyyy(reportDate);
  info(`reportDate=${reportDate} (current ${SETTINGS.reportTimeZone} day by default)`);

  if (!args.force && !args.buildOnly && alreadySent(reportDate)) {
    info(`already sent for ${reportDate} — exiting (use --force to override).`);
    return;
  }

  // Resolve summary JSON in this order:
  //   1. --use-ai → call Anthropic API, overwrite curated/<date>.json
  //   2. --summary=<path> flag (explicit override)
  //   3. kruse-summary/curated/<date>.json (hand-curated or prior AI output)
  //   4. null → renderer falls back to raw cards
  let summary = null;
  if (args.useAi) {
    info('--use-ai: calling Anthropic API to generate summary');
    summary = await summarizeDay(reportDate, { dryRun: args.aiDryRun });
  } else {
    let summaryPath = null;
    if (args.summary) {
      summaryPath = path.isAbsolute(args.summary) ? args.summary : path.join(ROOT, args.summary);
    } else {
      const auto = path.join(ROOT, 'curated', `${reportDate}.json`);
      if (fs.existsSync(auto)) summaryPath = auto;
    }
    if (summaryPath) {
      summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
      info(`loaded summary from ${summaryPath}`);
    } else {
      info('no curated summary found; using raw-card fallback');
    }
  }
  const html = buildReportHtml(reportDate, summary);
  const outDir = path.join(ROOT, 'out');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${reportDate}.html`);
  writeFileSync(outPath, html, 'utf8');
  info(`wrote ${outPath} (${html.length} bytes)`);

  if (args.buildOnly) { info('build-only mode, skipping send.'); return; }

  if (!args.force && !args.skipWindow) {
    let windowResult;
    try {
      windowResult = await checkSendWindow();
    } catch (e) {
      warn(`could not check sunrise send window (${e.message}); skipping send until next run.`);
      return;
    }
    const { inWindow, target } = windowResult;
    if (!inWindow) {
      info(`not in send window (target=${target.toISOString()}). Exiting.`);
      return;
    }
  } else {
    warn(args.force
      ? '--force: bypassing sunrise window check and last-sent guard.'
      : '--skip-window: bypassing sunrise window check but keeping last-sent guard.');
  }

  await sendReportEmail({
    subject: `Daily Kruse Summary - ${dateDisplay}`,
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
