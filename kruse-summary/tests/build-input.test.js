import test from 'node:test';
import assert from 'node:assert/strict';

import { buildInput } from '../code/build-input.js';

test('forum input uses the daily last-24h scrape instead of trimming to UTC day', () => {
  const input = buildInput('2026-05-26');
  const titles = input.forum.posts.map((post) => post.thread_title);

  assert.equal(input.twitter.tweet_count, 4);
  assert.equal(input.forum.post_count, 33);
  assert.ok(titles.includes('THE ANCIENTS...........WHAT DID THEY KNOW?'));
});
