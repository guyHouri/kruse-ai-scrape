// CLI entry point. Examples:
//   node main.js                   # scrape today as a UTC calendar day, full cap
//   node main.js --today           # same
//   node main.js --test            # 2-tweet smoke test, no parent fetches (~$0.01)
//   node main.js --date=2026-05-20
//   node main.js --date=2026-05-20 --window=24   # rolling 24h window ending now
//   node main.js --since=2026-05-15 --until=2026-05-21
//
// For daily cron: call with no args from a scheduler.

import { initLogger, info, warn, error } from './code/logger.js';
import { scrapeDay } from './code/scrape-day.js';
import { SETTINGS } from './settings.js';

function todayUtc() { return new Date().toISOString().slice(0, 10); }

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split('=')[1] : null;
  };
  return {
    today: args.includes('--today'),
    test: args.includes('--test'),
    date: get('date'),
    since: get('since'),
    until: get('until'),
    windowHours: get('window') ? Number(get('window')) : null,
  };
}

function* dateRange(since, until) {
  let cur = since;
  while (cur < until) {
    yield cur;
    const [y, m, d] = cur.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + 1);
    cur = dt.toISOString().slice(0, 10);
  }
}

async function main() {
  initLogger({ slug: 'scrape' });
  const args = parseArgs();

  let dates;
  if (args.since && args.until) dates = [...dateRange(args.since, args.until)];
  else if (args.date) dates = [args.date];
  else dates = [todayUtc()];

  const opts = {};
  if (args.test) {
    warn(`TEST MODE: capping to 2 tweets, no parent fetches. ` +
      `Projected cost ≤ $${(2 * SETTINGS.costPerTweetUsd).toFixed(3)}.`);
    opts.maxItems = 2;
    opts.depthOverride = 0;
  }
  if (args.windowHours) opts.windowHours = args.windowHours;

  info(`scraping ${dates.length} day(s): ${dates.join(', ')}`);
  for (const d of dates) await scrapeDay(d, opts);
  info('done.');
}

main().catch((e) => {
  error(`crashed: ${e.stack || e.message}`);
  process.exit(1);
});
