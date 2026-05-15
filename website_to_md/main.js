import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCrawler } from './code/crawler.js';
import { runExtractor } from './code/extractor.js';
import { initLogger, info, error } from './code/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEBSITES_PATH = path.join(__dirname, 'websites.json');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const target = args.find((a) => !a.startsWith('--'));

const crawlOnly = flags.has('--crawl-only');
const extractOnly = flags.has('--extract-only');

if (crawlOnly && extractOnly) {
  console.error('Cannot use --crawl-only and --extract-only together.');
  process.exit(1);
}

async function main() {
  const stage = crawlOnly ? 'crawl' : extractOnly ? 'extract' : 'full';
  initLogger({ slug: target ? `${stage}_${target}` : stage });

  // One-line active/inactive summary, mirrors whatsapp_to_md/main.js:49.
  const sites = JSON.parse(await readFile(WEBSITES_PATH, 'utf-8'));
  const total = sites.length;
  const active = sites.filter((s) => s.is_active !== false).length;
  const inactive = total - active;
  if (target) {
    info(`📋 ${total} total sites · target=${target} (CLI override bypasses active filter)`);
  } else {
    info(`📋 ${total} total sites · ${active} active · ${inactive} inactive`);
  }

  if (!extractOnly) {
    await runCrawler(target);
  }
  if (!crawlOnly) {
    await runExtractor(target);
  }
  info('Done.');
}

main().catch((err) => {
  error(`pipeline crashed: ${err.stack || err.message}`);
  process.exit(1);
});
