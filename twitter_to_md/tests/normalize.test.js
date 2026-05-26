import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeResponse } from '../code/normalize.js';

test('normalizes long tweets, quoted tweets, media, and metrics', () => {
  const [tweet] = normalizeResponse({
    data: [
      {
        id: '10',
        text: 'short text',
        note_tweet: { text: 'long-form text' },
        created_at: '2026-05-26T08:00:00Z',
        author_id: '1',
        conversation_id: '10',
        referenced_tweets: [{ type: 'quoted', id: '20' }],
        attachments: { media_keys: ['m1'] },
        public_metrics: { like_count: 3, retweet_count: 2, reply_count: 1, quote_count: 4, impression_count: 5 },
      },
    ],
    includes: {
      users: [{ id: '1', username: 'DrJackKruse', name: 'Jack Kruse' }],
      tweets: [{ id: '20', text: 'quoted text', author_id: '2', created_at: '2026-05-26T07:00:00Z' }],
      media: [{ media_key: 'm1', type: 'photo', url: 'https://example.com/photo.jpg' }],
    },
  });

  assert.equal(tweet.text, 'long-form text');
  assert.equal(tweet.url, 'https://x.com/DrJackKruse/status/10');
  assert.equal(tweet.is_quote, true);
  assert.equal(tweet.quoted_tweet.id, '20');
  assert.deepEqual(tweet.media, [
    { type: 'photo', url: 'https://example.com/photo.jpg', preview_url: null },
  ]);
  assert.equal(tweet.metrics.views, 5);
});
