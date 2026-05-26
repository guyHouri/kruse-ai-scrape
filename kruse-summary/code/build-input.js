// CLI/helper: merge compact tweets + forum daily posts into one AI input JSON.
//
// Usage:
//   node code/build-input.js [YYYY-MM-DD]
//   (defaults to today UTC)

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SETTINGS } from '../settings.js';
import { compactTweet } from './compact.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function todayUtc() { return new Date().toISOString().slice(0, 10); }

function windowForDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  const end = new Date(Date.UTC(y, m - 1, d + 1));
  const start = new Date(end.getTime() - SETTINGS.summaryWindowHours * 60 * 60 * 1000);
  return { start, end };
}

function readJsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => path.join(dir, f))
    .map((file) => JSON.parse(readFileSync(file, 'utf8')));
}

function inWindow(iso, start, end) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && t >= start.getTime() && t < end.getTime();
}

function loadTwitterWindow(date) {
  const { start, end } = windowForDate(date);
  const dir = path.resolve(ROOT, SETTINGS.scrapedDataDir);
  const seen = new Set();
  const tweets = [];
  let handle = 'DrJackKruse';

  for (const day of readJsonFiles(dir)) {
    if (day.handle) handle = day.handle;
    for (const tweet of day.tweets || []) {
      if (!tweet.id || seen.has(tweet.id)) continue;
      if (!inWindow(tweet.created_at, start, end)) continue;
      seen.add(tweet.id);
      tweets.push(tweet);
    }
  }

  tweets.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return {
    date,
    handle,
    window_hours: SETTINGS.summaryWindowHours,
    window_start_utc: start.toISOString(),
    window_end_utc: end.toISOString(),
    tweet_count: tweets.length,
    tweets: tweets.map(compactTweet),
  };
}

function compactForumPosts(posts, start = null, end = null) {
  const seen = new Set();
  const out = [];
  for (const p of posts) {
    if (start && end && !inWindow(p.posted_at, start, end)) continue;
    const key = p.post_url || `${p.thread_url}|${p.posted_at}|${p.author || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      thread_title: p.thread_title,
      thread_url: p.thread_url,
      author: p.author,
      posted_at: p.posted_at,
      forum_name: p.forum_name,
      content: p.content,
    });
  }
  out.sort((a, b) => new Date(b.posted_at) - new Date(a.posted_at));
  return out;
}

function loadForumWindow(date) {
  const { start, end } = windowForDate(date);
  const dir = path.resolve(ROOT, SETTINGS.forumDailyDir);
  const dayFile = path.join(dir, `${date}.json`);
  if (existsSync(dayFile)) {
    const day = JSON.parse(readFileSync(dayFile, 'utf8'));
    const windowHours = day.window_hours || SETTINGS.summaryWindowHours;
    const fetchedAt = day.fetched_at ? new Date(day.fetched_at) : null;
    const windowEnd = fetchedAt && Number.isFinite(fetchedAt.getTime()) ? fetchedAt : end;
    const windowStart = new Date(windowEnd.getTime() - windowHours * 60 * 60 * 1000);
    const compactPosts = compactForumPosts(day.posts || []);
    return {
      post_count: compactPosts.length,
      window_hours: windowHours,
      window_start_utc: windowStart.toISOString(),
      window_end_utc: windowEnd.toISOString(),
      posts: compactPosts,
    };
  }

  const posts = readJsonFiles(dir).flatMap((day) => day.posts || []);
  const compactPosts = compactForumPosts(posts, start, end);
  return {
    post_count: compactPosts.length,
    window_hours: SETTINGS.summaryWindowHours,
    window_start_utc: start.toISOString(),
    window_end_utc: end.toISOString(),
    posts: compactPosts,
  };
}

export function buildInput(date) {
  return {
    date,
    window_hours: SETTINGS.summaryWindowHours,
    twitter: loadTwitterWindow(date),
    forum: loadForumWindow(date),
  };
}

export function buildInputFile(date) {
  const input = buildInput(date);
  const outDir = path.join(ROOT, 'curated');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${date}-input.json`);
  writeFileSync(outPath, JSON.stringify(input, null, 2), 'utf8');
  return { input, outPath };
}

function main() {
  const date = process.argv[2] || todayUtc();
  const { input, outPath } = buildInputFile(date);
  console.log(`wrote ${path.relative(ROOT, outPath)} - ${input.twitter.tweet_count} tweets + ${input.forum.post_count} forum posts`);
  console.log(`window: ${input.twitter.window_start_utc} -> ${input.twitter.window_end_utc} (${input.window_hours}h)`);
  console.log(`approx size: ${(JSON.stringify(input).length / 1024).toFixed(1)} KB`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
