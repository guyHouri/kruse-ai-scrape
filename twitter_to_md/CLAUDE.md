# twitter_to_md — AI assistant notes

Public docs: [`README.md`](README.md).

One-stage pipeline: pull @DrJackKruse tweets for a given UTC day from the
**official X API v2**, normalize, walk parent reply chains, save as one JSON
per day.

## Backend choice (why X API v2)

History: tried Apify `apidojo/tweet-scraper` (rental, free-plan blocked) and
`kaitoeasyapi/...` (silent gate, returned mock data). Both rejected.
Settled on official X API — pay-per-tweet (~$0.005), $5/mo free credit
covers expected volume (~$0.40/mo for this account).

## Code layout

| File | Purpose |
|---|---|
| `main.js` | CLI; flags: `--today`, `--test`, `--date=YYYY-MM-DD`, `--since=/--until=` |
| `settings.js` | Handle, bearer token, caps, cost guard |
| `code/x-api.js` | X API v2 client — `resolveUserId`, `fetchUserTweetsForRange`, `fetchTweetsByIds`, `fetchTweetById` |
| `code/normalize.js` | X API v2 response → stable on-disk schema; recursive for quoted/retweeted via `includes.tweets` |
| `code/resolve-threads.js` | Walks `in_reply_to` chain, batch-fetches missing parents, attaches `thread_context` |
| `code/scrape-day.js` | Day orchestrator: cost projection → fetch → normalize → resolve → save |
| `code/storage.js` | JSON read/write under `data/`, global `data/index.json` for dedup + cross-day parent cache |
| `code/logger.js` | Console-only logger, matches forum_to_md shape |

## Cost guard

`settings.maxProjectedCostUsd` (default $1.50). `scrapeDay` computes
`maxItems × costPerTweetUsd × (1 + depth × 0.25)` and aborts before any API
call if it exceeds the cap. Bump it for big backfills.

`--test` flag: caps to 2 tweets, depth=0. Always run this first against a
fresh bearer token.

## X API v2 schema notes

Tweet object key fields we read:
- `id`, `text`, `created_at` (ISO 8601), `author_id`, `conversation_id`
- `in_reply_to_user_id`
- `referenced_tweets: [{ type: "replied_to" | "quoted" | "retweeted", id }]`
- `public_metrics: { retweet_count, reply_count, like_count, quote_count, impression_count }`
- `attachments.media_keys`

We request `expansions=author_id,referenced_tweets.id,referenced_tweets.id.author_id,attachments.media_keys`
so `includes.users`, `includes.tweets`, `includes.media` come back populated.

## Output invariants

- One file per UTC day at `data/YYYY-MM-DD.json`.
- `tweet_count === tweets.length`.
- `thread_context` ordered **root → direct parent**; tweet itself top-level.
  Nested `thread_context` stripped from context items.
- `quoted_tweet`, `retweeted_tweet` recursively normalized (one level — X API
  only returns first-level expansion).
- Parent tweets fetched for one day are cached in `data/` and reused — if a
  later day replies to the same parent, no extra API call.

## Don't read into chat unless asked

- `data/*.json` — use `loadDay(date)` from `code/storage.js`.
- `data/index.json` — grows unbounded.

## Resume / idempotency

`scrapeDay(date)` overwrites the day file and merges into the index. Safe to
re-run. No partial-write protection — files are small.
