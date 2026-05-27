import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { buildInput } from '../code/build-input.js';
import { SETTINGS } from '../settings.js';

test('forum input uses the daily last-24h scrape instead of trimming to UTC day', () => {
  const input = buildInput('2026-05-26');
  const titles = input.forum.posts.map((post) => post.thread_title);

  assert.equal(input.twitter.tweet_count, 4);
  assert.equal(input.forum.post_count, 33);
  assert.ok(titles.includes('THE ANCIENTS...........WHAT DID THEY KNOW?'));
});

test('buildInput uses mocked 24-hour windows across source files', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'kruse-input-window-'));
  const twitterDir = path.join(tmp, 'twitter');
  const forumDir = path.join(tmp, 'forum');
  mkdirSync(twitterDir);
  mkdirSync(forumDir);

  const originalScrapedDataDir = SETTINGS.scrapedDataDir;
  const originalForumDailyDir = SETTINGS.forumDailyDir;
  try {
    SETTINGS.scrapedDataDir = twitterDir;
    SETTINGS.forumDailyDir = forumDir;

    writeFileSync(path.join(twitterDir, '2026-05-25.json'), JSON.stringify({
      date: '2026-05-25',
      handle: 'DrJackKruse',
      tweets: [
        { id: 'old-tweet', text: 'too old', created_at: '2026-05-25T23:59:59.000Z' },
        { id: 'inside-early', text: 'inside early', created_at: '2026-05-26T00:00:00.000Z' },
      ],
    }), 'utf8');
    writeFileSync(path.join(twitterDir, '2026-05-26.json'), JSON.stringify({
      date: '2026-05-26',
      handle: 'DrJackKruse',
      tweets: [
        { id: 'inside-late', text: 'inside late', created_at: '2026-05-26T23:59:59.000Z' },
        { id: 'future-tweet', text: 'too new', created_at: '2026-05-27T00:00:00.000Z' },
        { id: 'inside-early', text: 'duplicate', created_at: '2026-05-26T12:00:00.000Z' },
      ],
    }), 'utf8');

    writeFileSync(path.join(forumDir, '2026-05-25.json'), JSON.stringify({
      posts: [
        {
          post_url: 'old-post',
          thread_title: 'Old forum post',
          thread_url: 'https://forum.example/old',
          posted_at: '2026-05-25T23:59:59.000Z',
          author: 'Jack Kruse',
          content: 'too old',
        },
      ],
    }), 'utf8');
    writeFileSync(path.join(forumDir, '2026-05-24.json'), JSON.stringify({
      posts: [
        {
          post_url: 'inside-post',
          thread_title: 'Inside forum post',
          thread_url: 'https://forum.example/inside',
          posted_at: '2026-05-26T01:00:00.000Z',
          author: 'Jack Kruse',
          content: 'inside',
        },
        {
          post_url: 'future-post',
          thread_title: 'Future forum post',
          thread_url: 'https://forum.example/future',
          posted_at: '2026-05-27T00:00:00.000Z',
          author: 'Jack Kruse',
          content: 'too new',
        },
      ],
    }), 'utf8');

    const input = buildInput('2026-05-26');

    assert.deepEqual(input.twitter.tweets.map((tweet) => tweet.id), ['inside-late', 'inside-early']);
    assert.deepEqual(input.forum.posts.map((post) => post.thread_title), ['Inside forum post']);
    assert.equal(input.twitter.window_start_utc, '2026-05-26T00:00:00.000Z');
    assert.equal(input.twitter.window_end_utc, '2026-05-27T00:00:00.000Z');
  } finally {
    SETTINGS.scrapedDataDir = originalScrapedDataDir;
    SETTINGS.forumDailyDir = originalForumDailyDir;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildInput trusts rolling twitter scrape windows for early Israel reports', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'kruse-twitter-rolling-'));
  const twitterDir = path.join(tmp, 'twitter');
  const forumDir = path.join(tmp, 'forum');
  mkdirSync(twitterDir);
  mkdirSync(forumDir);

  const originalScrapedDataDir = SETTINGS.scrapedDataDir;
  const originalForumDailyDir = SETTINGS.forumDailyDir;
  try {
    SETTINGS.scrapedDataDir = twitterDir;
    SETTINGS.forumDailyDir = forumDir;

    writeFileSync(path.join(twitterDir, '2026-05-26.json'), JSON.stringify({
      date: '2026-05-26',
      handle: 'DrJackKruse',
      tweets: [
        { id: 'inside-previous-utc', text: 'inside previous UTC day', created_at: '2026-05-26T02:30:00.000Z' },
        { id: 'too-old', text: 'too old', created_at: '2026-05-26T00:59:59.000Z' },
      ],
    }), 'utf8');
    writeFileSync(path.join(twitterDir, '2026-05-27.json'), JSON.stringify({
      date: '2026-05-27',
      handle: 'DrJackKruse',
      range_mode: 'rolling',
      window_hours: 24,
      window_start_utc: '2026-05-26T01:00:00.000Z',
      window_end_utc: '2026-05-27T01:00:00.000Z',
      tweets: [
        { id: 'inside-current-file', text: 'inside current file', created_at: '2026-05-27T00:30:00.000Z' },
        { id: 'too-new', text: 'too new', created_at: '2026-05-27T01:00:00.000Z' },
      ],
    }), 'utf8');
    writeFileSync(path.join(forumDir, '2026-05-27.json'), JSON.stringify({
      fetched_at: '2026-05-27T01:00:00.000Z',
      window_hours: 24,
      posts: [],
    }), 'utf8');

    const input = buildInput('2026-05-27');

    assert.deepEqual(input.twitter.tweets.map((tweet) => tweet.id), [
      'inside-current-file',
      'inside-previous-utc',
    ]);
    assert.equal(input.twitter.window_source, 'rolling');
    assert.equal(input.twitter.window_start_utc, '2026-05-26T01:00:00.000Z');
    assert.equal(input.twitter.window_end_utc, '2026-05-27T01:00:00.000Z');
  } finally {
    SETTINGS.scrapedDataDir = originalScrapedDataDir;
    SETTINGS.forumDailyDir = originalForumDailyDir;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildInput trusts a mocked forum daily last-24h file instead of UTC trimming it again', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'kruse-forum-daily-'));
  const twitterDir = path.join(tmp, 'twitter');
  const forumDir = path.join(tmp, 'forum');
  mkdirSync(twitterDir);
  mkdirSync(forumDir);

  const originalScrapedDataDir = SETTINGS.scrapedDataDir;
  const originalForumDailyDir = SETTINGS.forumDailyDir;
  try {
    SETTINGS.scrapedDataDir = twitterDir;
    SETTINGS.forumDailyDir = forumDir;

    writeFileSync(path.join(twitterDir, '2026-05-26.json'), JSON.stringify({
      date: '2026-05-26',
      handle: 'DrJackKruse',
      tweets: [],
    }), 'utf8');
    writeFileSync(path.join(forumDir, '2026-05-26.json'), JSON.stringify({
      fetched_at: '2026-05-26T12:00:00.000Z',
      window_hours: 24,
      posts: [
        {
          post_url: 'late-previous-utc-day',
          thread_title: 'Late previous UTC day but inside forum scrape',
          thread_url: 'https://forum.example/inside-daily',
          posted_at: '2026-05-25T22:30:00.000Z',
          author: 'Jack Kruse',
          content: 'inside scraper-defined 24h window',
        },
      ],
    }), 'utf8');

    const input = buildInput('2026-05-26');

    assert.equal(input.forum.post_count, 1);
    assert.equal(input.forum.posts[0].thread_title, 'Late previous UTC day but inside forum scrape');
    assert.equal(input.forum.window_start_utc, '2026-05-25T12:00:00.000Z');
    assert.equal(input.forum.window_end_utc, '2026-05-26T12:00:00.000Z');
  } finally {
    SETTINGS.scrapedDataDir = originalScrapedDataDir;
    SETTINGS.forumDailyDir = originalForumDailyDir;
    rmSync(tmp, { recursive: true, force: true });
  }
});
