import { runDiscover } from './code/discover.js';
import { runExtract } from './code/extract.js';
import { runSplit } from './code/split-and-index.js';
import { runStatus } from './code/status.js';
import { initLogger, info, error } from './code/logger.js';

const args = process.argv.slice(2);
const flagArgs = args.filter((a) => a.startsWith('--'));
const flags = new Set(flagArgs.map((a) => a.split('=')[0]));

const discoverOnly = flags.has('--discover-only');
const extractOnly = flags.has('--extract-only');
const splitOnly = flags.has('--split-only');
const statusOnly = flags.has('--status');

const limitFlag = flagArgs.find((a) => a.startsWith('--limit='));
const limit = limitFlag ? Number(limitFlag.split('=')[1]) : null;

const onlyFlags = [discoverOnly, extractOnly, splitOnly, statusOnly].filter(Boolean);
if (onlyFlags.length > 1) {
  console.error('Only one --*-only flag at a time.');
  process.exit(1);
}

async function main() {
  if (statusOnly) {
    await runStatus();
    return;
  }
  const stage = discoverOnly ? 'discover'
    : extractOnly ? 'extract'
    : splitOnly ? 'split'
    : 'full';
  initLogger({ slug: stage });

  if (!extractOnly && !splitOnly) await runDiscover();
  if (!discoverOnly && !splitOnly) await runExtract({ limit });
  if (!discoverOnly && !extractOnly) await runSplit();
  info('Done.');
}

main().catch((err) => {
  error(`pipeline crashed: ${err.stack || err.message}`);
  process.exit(1);
});
