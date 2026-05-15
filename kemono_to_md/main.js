import { runDiscover } from './code/discover.js';
import { runExtract } from './code/extract.js';
import { runOrganizeArticles } from './code/organize-articles.js';
import { runConvertPdfBlogs } from './code/convert-pdf-blogs.js';
import { runBundle } from './code/bundle.js';
import { initLogger, info, error } from './code/logger.js';

const args = process.argv.slice(2);
const flagArgs = args.filter((a) => a.startsWith('--'));
const flags = new Set(flagArgs.map((a) => a.split('=')[0]));

const discoverOnly = flags.has('--discover-only');
const extractOnly = flags.has('--extract-only');
const organizeOnly = flags.has('--organize-only');
const pdfOnly = flags.has('--pdf-only');
const bundleOnly = flags.has('--bundle-only');

const onlyFlags = [discoverOnly, extractOnly, organizeOnly, pdfOnly, bundleOnly].filter(Boolean);
if (onlyFlags.length > 1) {
  console.error('Only one --*-only flag at a time.');
  process.exit(1);
}

const limitFlag = flagArgs.find((a) => a.startsWith('--limit='));
const limit = limitFlag ? Number(limitFlag.split('=')[1]) : null;

async function main() {
  const stage = discoverOnly ? 'discover'
    : extractOnly ? 'extract'
    : organizeOnly ? 'organize'
    : pdfOnly ? 'pdf'
    : bundleOnly ? 'bundle'
    : 'full';
  initLogger({ slug: stage });

  if (organizeOnly) {
    await runOrganizeArticles({ reset: true });
    info('Done.');
    return;
  }
  if (pdfOnly) {
    await runConvertPdfBlogs();
    info('Done.');
    return;
  }
  if (!extractOnly && !bundleOnly) {
    await runDiscover();
  }
  if (!discoverOnly && !bundleOnly) {
    await runExtract({ limit });
  }
  if (!discoverOnly && !extractOnly && !bundleOnly) {
    await runOrganizeArticles({ reset: true });
    await runConvertPdfBlogs();
  }
  if (!discoverOnly && !extractOnly) {
    await runBundle();
  }
  info('Done.');
}

main().catch((err) => {
  error(`pipeline crashed: ${err.stack || err.message}`);
  process.exit(1);
});
