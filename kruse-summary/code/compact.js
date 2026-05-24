// Compact a day's normalized tweets into a token-optimized JSON suitable
// for sending to an LLM as input.
//
// Keys are intentionally readable (not single-char) so the model has no
// ambiguity about what each field means. Compression comes from DROPPING
// noise fields, not from key shortening.
//
// What we drop vs the full normalized form:
//   - `url` (reconstructable from id + author username)
//   - `author` block for the account owner (constant = the handle in the wrapper)
//   - `lang` (mostly "en")
//   - `conversation_id`, `in_reply_to.user_id`/`url` (noise for summarization)
//   - `is_reply / is_quote / is_retweet` booleans (collapsed into single `type` field)
//   - `retweeted_tweet` (re-cast as `type: "retweet"`, body promoted to `quoted`)
//   - empty arrays and null fields
//   - low-signal metrics (retweets/replies/quotes), keeping likes + views
//
// Per-tweet shape (model-facing):
//   {
//     id:        "<tweet_id>",
//     text:      "<text, t.co tail already stripped>",
//     time_utc:  "HH:MM",
//     type:      "post" | "reply" | "quote" | "retweet",
//     likes:     <int, optional>,
//     views:     <int, optional>,
//     quoted:    { user, text },           // only when type == quote | retweet
//     reply_chain: [ { user, text } ],     // root → direct parent, only when type == reply
//     media:     ["photo" | "video" | "animated_gif"]   // only when present
//   }
//
// Wrapper:
//   {
//     date: "YYYY-MM-DD",
//     handle: "DrJackKruse",
//     tweet_count: <int>,
//     tweets: [ ... ]
//   }

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SETTINGS } from '../settings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function stripTcoTail(s) {
  if (!s) return '';
  return String(s).replace(/\s*https?:\/\/t\.co\/\S+\s*$/g, '').trim();
}

function hhmm(iso) {
  if (!iso) return null;
  return iso.slice(11, 16);
}

function ymd(iso) {
  if (!iso) return null;
  return iso.slice(0, 10);
}

function typeOf(t) {
  if (t.is_retweet) return 'retweet';
  if (t.is_quote) return 'quote';
  if (t.is_reply) return 'reply';
  return 'post';
}

function compactNested(t) {
  if (!t) return null;
  return {
    user: t.author?.username || null,
    text: stripTcoTail(t.text),
  };
}

export function compactTweet(t) {
  const out = {
    id: t.id,
    text: stripTcoTail(t.text),
    date_utc: ymd(t.created_at),
    time_utc: hhmm(t.created_at),
    type: typeOf(t),
  };
  if (t.metrics?.likes != null && t.metrics.likes > 0) out.likes = t.metrics.likes;
  if (t.metrics?.views != null && t.metrics.views > 0) out.views = t.metrics.views;

  const quoted = t.quoted_tweet || t.retweeted_tweet;
  if (quoted) out.quoted = compactNested(quoted);

  if (Array.isArray(t.thread_context) && t.thread_context.length) {
    out.reply_chain = t.thread_context.map(compactNested).filter(Boolean);
  }

  if (Array.isArray(t.media) && t.media.length) {
    out.media = t.media.map((m) => m.type).filter(Boolean);
  }
  return out;
}

export function compactDay(day) {
  return {
    date: day.date,
    handle: day.handle,
    tweet_count: day.tweet_count ?? (day.tweets?.length || 0),
    tweets: (day.tweets || []).map(compactTweet),
  };
}

export function loadAndCompact(date) {
  const file = path.resolve(ROOT, SETTINGS.scrapedDataDir, `${date}.json`);
  if (!existsSync(file)) throw new Error(`scraped file not found: ${file}`);
  const day = JSON.parse(readFileSync(file, 'utf8'));
  return compactDay(day);
}

// CLI: `node code/compact.js [YYYY-MM-DD]` → prints compact JSON to stdout.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = process.argv[2];
  let date = arg;
  if (!date) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    date = d.toISOString().slice(0, 10);
  }
  const compact = loadAndCompact(date);
  process.stdout.write(JSON.stringify(compact, null, 2));
  process.stdout.write('\n');
}
