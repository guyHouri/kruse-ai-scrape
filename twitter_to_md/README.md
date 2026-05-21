# twitter_to_md

Scrape Dr Jack Kruse's X/Twitter posts (default `@DrJackKruse`) into per-day
JSON files, with full reply-chain context attached to each tweet.

Built as part of the [kruse-ai-scrape](../README.md) project — the JSON files
are designed to be ingested by downstream AI summarization / RAG pipelines.

## Why JSON, not Markdown

Tweets are graph-structured (reply chains, quote tweets, nested retweets).
Markdown is a presentation format and is lossy for nested structure. JSON
preserves the full tree so:

- AI tools can parse `in_reply_to`, `quoted_tweet`, `thread_context` directly.
- Re-renders to Markdown / HTML stay possible without re-scraping.
- Metrics, media URLs, timestamps survive round-trips.

A Markdown export pass can be added later as a pure transform over the JSON.

## Backend: official X API v2

Uses the official X API directly. Pricing (2026, see
[X API pricing](https://docs.x.com/x-api/getting-started/pricing)):

- pay-per-tweet, ~$0.005 per tweet returned
- $5/mo free credit on signup
- For @DrJackKruse (~30-50 tweets/day, ~1500/mo): expected cost ~$0.25-0.40/mo
  → well within the free credit

Endpoints used:
- `GET /2/users/by/username/:username` — resolve `user_id` once per run
- `GET /2/users/:id/tweets` — user timeline within `start_time`/`end_time` window
- `GET /2/tweets` — batch-fetch parent tweets for thread reconstruction

Auth: App-only **Bearer Token** from
[developer.x.com](https://developer.x.com/en/portal/dashboard) → your app →
Keys and tokens → Bearer Token.

## Install

```bash
cd twitter_to_md
npm install
cp .env.example .env
# edit .env, paste your X API Bearer Token
```

## Run

```bash
# smoke test first — caps at 2 tweets, no parent fetches, ≤ $0.01
node main.js --test

# today (UTC), full cap (200 tweets max, 6 levels of parent fetches)
npm start

# specific day
node main.js --date=2026-05-20

# backfill a range (inclusive start, exclusive end)
node main.js --since=2026-05-15 --until=2026-05-21
```

Cost guard: `settings.js → maxProjectedCostUsd` (default $1.50). Runs abort
before any API call if projected cost would exceed this. Raise to backfill.

## Output

```
data/
  2026-05-21.json     # one file per UTC day
  2026-05-22.json
  index.json          # tweet_id → date map (dedup + parent lookup)
logs/                 # console echoes
```

### Day file shape

```json
{
  "date": "2026-05-21",
  "handle": "DrJackKruse",
  "fetched_at": "2026-05-21T18:04:11.000Z",
  "source": { "backend": "x-api-v2", "endpoint": "/2/users/:id/tweets" },
  "tweet_count": 14,
  "tweets": [
    {
      "id": "1795...",
      "url": "https://x.com/DrJackKruse/status/1795...",
      "created_at": "2026-05-21T14:23:00.000Z",
      "text": "Sunlight is the substrate of life...",
      "lang": "en",
      "author": { "id": "...", "username": "DrJackKruse", "name": "Jack Kruse" },
      "is_reply": true,
      "is_quote": false,
      "is_retweet": false,
      "conversation_id": "1794...",
      "in_reply_to": {
        "tweet_id": "1794...",
        "user_id": "...",
        "url": "https://x.com/i/status/1794..."
      },
      "quoted_tweet": null,
      "retweeted_tweet": null,
      "media": [],
      "metrics": { "likes": 12, "retweets": 3, "replies": 1, "quotes": 0, "views": 1024 },
      "thread_context": [
        { "id": "1793...", "text": "root tweet ...", "author": {...} },
        { "id": "1794...", "text": "direct parent ...", "author": {...} }
      ]
    }
  ]
}
```

`thread_context` is ordered **root → direct parent**. The reply tweet itself
is the top-level object. Walk depth capped by `settings.maxThreadDepth`
(default 6).

## Daily cron

Designed for a daily scheduled run. Minimal GH Actions:

```yaml
on:
  schedule:
    - cron: '15 2 * * *'   # 02:15 UTC daily
jobs:
  scrape:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
        working-directory: twitter_to_md
      - run: npm start
        working-directory: twitter_to_md
        env:
          XAPI_BEARER_TOKEN: ${{ secrets.XAPI_BEARER_TOKEN }}
      - run: |
          git config user.name "twitter-bot"
          git config user.email "bot@example.com"
          git add twitter_to_md/data
          git commit -m "twitter: daily scrape" || echo "no changes"
          git push
```

## What this code uses

- **Official X API v2** — direct HTTPS calls via Node's built-in `fetch`.
  No third-party SDK; we use the API directly to keep the dependency surface tiny.
- **[`dotenv`](https://www.npmjs.com/package/dotenv)** — loads `XAPI_BEARER_TOKEN`
  from `.env`.
- Node 20+ built-ins: `fs`, `path`, `url`, `fetch`.

No browser automation, no logged-in scraping account, no proxies, no Apify.
Just the official API plus the free monthly credit.
