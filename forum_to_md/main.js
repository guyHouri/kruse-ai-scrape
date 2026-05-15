import { runDiscover } from './code/discover.js';
import { runJackDiscover } from './code/jack-discover.js';
import { runNotJackDiscover } from './code/not-jack-discover.js';
import { runExtract } from './code/extract.js';
import { runSplit } from './code/split-and-index.js';
import { runRecover } from './code/recover-threads-json.js';
import { runStatus } from './code/status.js';
import { initLogger, info, error } from './code/logger.js';

const args = process.argv.slice(2);
const flagArgs = args.filter((a) => a.startsWith('--'));
const flags = new Set(flagArgs.map((a) => a.split('=')[0]));

const discoverOnly = flags.has('--discover-only');
const jackDiscoverOnly = flags.has('--jack-discover-only');
const extractOnly = flags.has('--extract-only');
const splitOnly = flags.has('--split-only');
const recoverOnly = flags.has('--recover-only');
const notJackDiscoverOnly = flags.has('--not-jack-discover-only');
const statusOnly = flags.has('--status');

// Optional smoke-test cap: `--limit=3` processes only the first 3 threads
// during extract. Useful for verifying output format without committing to
// a full multi-hour run.
const limitFlag = flagArgs.find((a) => a.startsWith('--limit='));
const limit = limitFlag ? Number(limitFlag.split('=')[1]) : null;

// Optional extract shard: `--shard=0/3` processes pending threads where
// id % 3 === 0. Lets multiple extract processes run in parallel without
// duplicating work.
const shardFlag = flagArgs.find((a) => a.startsWith('--shard='));
let shard = null;
if (shardFlag) {
  const m = shardFlag.split('=')[1].match(/^(\d+)\/(\d+)$/);
  if (m) shard = { index: Number(m[1]), total: Number(m[2]) };
}

// Optional subforum-id filter for not-jack-discover (e.g. --subforums=17 for
// Optimal Journal). Comma-separated list of XenForo node ids.
const subforumsFlag = flagArgs.find((a) => a.startsWith('--subforums='));
const subforumIds = subforumsFlag
  ? subforumsFlag.split('=')[1].split(',').filter(Boolean)
  : null;

const onlyFlags = [discoverOnly, jackDiscoverOnly, extractOnly, splitOnly, recoverOnly, notJackDiscoverOnly].filter(Boolean);
if (onlyFlags.length > 1) {
  console.error('Only one --*-only flag at a time.');
  process.exit(1);
}

async function main() {
  if (statusOnly) {
    await runStatus();
    return;
  }
  const stage = recoverOnly ? 'recover'
    : discoverOnly ? 'discover'
    : jackDiscoverOnly ? 'jack-discover'
    : extractOnly ? 'extract'
    : splitOnly ? 'split'
    : 'full';
  initLogger({ slug: stage });

  if (recoverOnly) {
    await runRecover();
    info('Done.');
    return;
  }
  if (notJackDiscoverOnly) {
    await runNotJackDiscover({ subforumIds });
    info('Done.');
    return;
  }

  // Stage chain: pinned discover → jack-contributed discover → extract → split.
  // Each stage is idempotent and resume-safe via threads.json's extracted flag
  // + per-thread MD files. `npm start` runs everything; each --*-only flag
  // gates one stage in isolation.
  if (!jackDiscoverOnly && !extractOnly && !splitOnly) {
    await runDiscover();           // pinned threads
  }
  if (!discoverOnly && !extractOnly && !splitOnly) {
    await runJackDiscover();       // jack-contributed threads
  }
  if (!discoverOnly && !jackDiscoverOnly && !splitOnly) {
    await runExtract({ limit, shard });   // fetches threads.json entries with extracted=false
  }
  if (!discoverOnly && !jackDiscoverOnly && !extractOnly) {
    await runSplit();              // quarterly bundles + xlsx
  }
  info('Done.');
}

main().catch((err) => {
  error(`pipeline crashed: ${err.stack || err.message}`);
  process.exit(1);
});
