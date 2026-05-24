// CLI helper: merge today's compact tweets + forum daily into ONE input JSON
// suitable for pasting into an AI chat alongside the summarize-system.md prompt.
//
// Usage:
//   node code/build-input.js [YYYY-MM-DD]      → writes curated/<date>-input.json
//   (defaults to today UTC)

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS } from '../settings.js';
import { loadAndCompact } from './compact.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function todayUtc() { return new Date().toISOString().slice(0, 10); }

function compactForum(day) {
  if (!day?.posts?.length) return { post_count: 0, window_hours: day?.window_hours || 24, posts: [] };
  return {
    post_count: day.posts.length,
    window_hours: day.window_hours || 24,
    posts: day.posts.map((p) => ({
      thread_title: p.thread_title,
      thread_url: p.thread_url,
      author: p.author,
      posted_at: p.posted_at,
      forum_name: p.forum_name,
      content: p.content,
    })),
  };
}

function loadForum(date) {
  const file = path.resolve(ROOT, SETTINGS.forumDailyDir, `${date}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function main() {
  const date = process.argv[2] || todayUtc();
  const compactTweets = loadAndCompact(date);
  const forum = compactForum(loadForum(date));

  const input = {
    date,
    twitter: compactTweets,
    forum,
  };

  const outDir = path.join(ROOT, 'curated');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${date}-input.json`);
  writeFileSync(outPath, JSON.stringify(input, null, 2), 'utf8');
  console.log(`wrote ${path.relative(ROOT, outPath)} — ${compactTweets.tweet_count} tweets + ${forum.post_count} forum posts`);
  console.log(`approx size: ${(JSON.stringify(input).length / 1024).toFixed(1)} KB`);
}

main();
