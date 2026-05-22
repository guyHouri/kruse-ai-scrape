// Daily forum scrape — separate CLI entry from main.js.
//
// Flow: username/password login → fetch /find-new/posts → filter to last 24h
// → save to forum_to_md/daily/<YYYY-MM-DD>.json.
//
// Designed for cron use: idempotent, single run, no shared state with the
// big main.js pipeline. Run via `npm run daily` or `node main-daily.js`.

import 'dotenv/config';
import { initLogger, info, error } from './code/logger.js';
import { loginToForum } from './code/daily-login.js';
import { fetchRecentPosts } from './code/daily-fetch.js';
import { saveDay } from './code/daily-storage.js';

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (n) => {
    const hit = args.find((a) => a.startsWith(`--${n}=`));
    return hit ? hit.split('=')[1] : null;
  };
  return {
    date: get('date'),
    windowHours: get('window') ? Number(get('window')) : 24,
  };
}

async function main() {
  initLogger({ slug: 'forum-daily' });
  const args = parseArgs();
  const date = args.date || todayUtc();
  info(`scraping forum new posts for ${date} (window=${args.windowHours}h)`);

  const { cookieString } = await loginToForum();
  const posts = await fetchRecentPosts(cookieString, { windowHours: args.windowHours });

  saveDay(date, {
    date,
    fetched_at: new Date().toISOString(),
    source: 'https://forum.jackkruse.com/find-new/posts/',
    window_hours: args.windowHours,
    post_count: posts.length,
    posts,
  });
  info('done.');
}

main().catch((e) => {
  error(`forum-daily crashed: ${e.stack || e.message}`);
  process.exit(1);
});
