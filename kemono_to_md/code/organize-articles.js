import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  readArticles,
  ARTICLES_DIR,
  BLOG_SERIES_DIR,
} from './storage.js';
import { classifyBlogSeries } from './series-utils.js';
import { info, warn, section } from './logger.js';

export async function runOrganizeArticles({ reset = false } = {}) {
  section('Organize API articles by blog series');
  if (reset) {
    await rm(BLOG_SERIES_DIR, { recursive: true, force: true });
  }
  const articles = await readArticles();
  const extracted = articles.filter((a) => a.extracted);
  const used = new Set();
  let written = 0;
  let skipped = 0;

  for (const entry of extracted) {
    const src = path.join(ARTICLES_DIR, articleFileFor(entry));
    if (!existsSync(src)) {
      warn(`post=${entry.id} marked extracted but missing ${path.basename(src)}`);
      skipped++;
      continue;
    }
    const classification = classifyBlogSeries(entry.title || '', src);
    const seriesDir = path.join(BLOG_SERIES_DIR, classification.series);
    await mkdir(seriesDir, { recursive: true });

    const targetName = uniqueName({
      dir: seriesDir,
      base: classification.filenameBase,
      suffix: entry.id,
      used,
    });
    const target = path.join(seriesDir, targetName);
    const md = await readFile(src, 'utf-8');
    await writeFile(target, md, 'utf-8');
    written++;
  }

  info(`-> organized ${written} API articles into ${path.relative(process.cwd(), BLOG_SERIES_DIR)} (skipped ${skipped})`);
}

function articleFileFor(entry) {
  const date = (entry.published_at || entry.added_at || 'unknown').slice(0, 10) || 'unknown';
  return `${date}-${entry.id}.md`;
}

function uniqueName({ dir, base, suffix, used }) {
  let name = `${base}.md`;
  let key = path.join(dir, name).toLowerCase();
  if (!used.has(key) && !existsSync(path.join(dir, name))) {
    used.add(key);
    return name;
  }
  name = `${base}-${suffix}.md`;
  key = path.join(dir, name).toLowerCase();
  let n = 2;
  while (used.has(key) || existsSync(path.join(dir, name))) {
    name = `${base}-${suffix}-${n}.md`;
    key = path.join(dir, name).toLowerCase();
    n++;
  }
  used.add(key);
  return name;
}
