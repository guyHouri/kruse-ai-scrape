# linkedin_to_md — scraper plan

## What we have

`linkedin_to_md/Jack Kruse - All blogs up to 13th April 2026.xlsx` already contains every URL we need. Three sheets:

| Sheet | Rows | Source | Action |
|---|---:|---|---|
| `Patreon (2017-2024)` | 1151 | `patreon.com/posts/<slug>` URLs | **Already covered** by `kemono_to_md/` — Kemono mirror grabs the same Patreon content. Skip in this module. |
| `LinkedIn (2016-2024)` | 1011 | `linkedin.com/pulse/<slug>-jack-kruse-<id>/` | **Primary target** of this module. |
| `JK.com (2011-2017)` | 1006 | `jackkruse.com/<slug>/` blog posts | Different from forum threads — adds a 4th source. Could fold into this module (`linkedin_to_md/` → rename to `blogs_to_md/`) or stay separate. Recommend: handle here under a separate sub-stage. |

## LinkedIn restriction reality (probed)

Probed `linkedin.com/pulse/wounds-create-wisdom-jack-kruse-sa3we/` with a plain `User-Agent`, no cookies:

- HTTP 200, 268 KB HTML
- Title extractable from `<h1>`
- `<article>` tag has 13.5 KB of cleanly-parseable text content
- 66 `<p>` tags inside
- JSON-LD metadata embedded
- "Sign in" prompts present in chrome but the article body is fully rendered server-side for SEO

**LinkedIn Pulse articles are publicly readable without authentication.** Your credentials are NOT needed for the primary scrape path. They're saved (gitignored) as a fallback in case LinkedIn rate-limits unauthenticated traffic mid-run.

## Architecture (mirrors forum_to_md)

```
linkedin_to_md/
├── README.md
├── SETUP.md                       (cookies fallback procedure if rate-limited)
├── AGENTS.md                      AI-assistant doc
├── package.json
├── settings.js                    UA, delays, retries, paths
├── main.js                        CLI dispatch
├── articles.json                  GENERATED — one entry per URL from xlsx
├── credentials.txt.example        gitignored real file: optional login fallback
├── code/
│   ├── discover.js                read xlsx → write articles.json
│   ├── extract.js                 fetch each article, parse <article>, write per-article MD
│   ├── linkedin.js                pure HTML parsing primitives (cheerio + turndown)
│   ├── http.js                    fetch wrapper (UA, timeout, retry, 429 detection)
│   ├── split-and-index.js         pack per-article MDs into linkedin#1.md..N.md + xlsx
│   ├── logger.js                  console + progress.log
│   ├── progress-log.js            (re-use forum_to_md's logger pattern)
│   └── status.js                  npm run status
├── processed_mds/
│   ├── articles/<slug>.<id>.md    one MD per article
│   └── linkedin#1.md..N.md        NotebookLM-sized bundles
└── logs/
    ├── progress.log
    └── workers.log
```

## Run order

1. `npm install`
2. `npm run discover` — read xlsx → write `articles.json` (1011 LinkedIn entries, optionally + 1006 jackkruse.com entries from the JK.com sheet)
3. `npm run extract` — fetch each article URL, parse `<article>` body, write per-article MD. Concurrency 3, 1-second delay per request. ~30-50 min for 1011 articles.
4. `npm run split` — pack per-article MDs into `linkedin#1.md..N.md` bundles ≤490k words / ≤195 MB each. Plus `linkedin-articles-index.xlsx`.
5. `npm run status` — live snapshot anytime.

## Per-article MD format (mirrors forum_to_md)

```markdown
══════════════════════════════════════════════════════════════════════
# Article: <title>
**Article URL:** <linkedin.com/pulse/...>
**Published:** <YYYY-MM-DD>
**Author:** Jack Kruse
**Word Count:** <N>
══════════════════════════════════════════════════════════════════════

<body markdown — Turndown-converted from <article>, images stripped>
```

## Bundle output

Same NotebookLM caps as forum_to_md: **≤490k words / ≤195 MB per file**, file count unbounded. Estimated:
- 1011 articles × ~1500 words avg = ~1.5M words
- ~3-4 bundle files

## Fallback if LinkedIn rate-limits

If unauthenticated traffic hits 429 / soft-block:
1. Cookies fall back: Playwright headed login → grab `li_at` cookie → use in http.js Cookie header.
2. Slower: 5-second delay per request, concurrency=1.
3. Last resort: Wayback Machine cached version of each URL.

Credentials you gave will be stored in `linkedin_to_md/credentials.txt` (gitignored, never echoed) and only loaded by the Playwright fallback path if the unauthenticated path fails. We don't risk your account on the first attempt.

## Approval needed

This plan does:
- ✅ Read 1011 URLs from xlsx
- ✅ Fetch each unauthenticated (LinkedIn allows it for Pulse SEO)
- ✅ Parse `<article>` → markdown
- ✅ Save creds to gitignored file for OPTIONAL fallback
- ❌ Does NOT use your credentials in the primary path
- ❌ Does NOT touch jackkruse.com blog yet (Phase 2 if you approve)

Estimated runtime: ~45 min. Risk of account ban: ~zero (no auth used). Output: 4-ish NotebookLM-sized bundles + per-article MDs + xlsx index.

Approve and I build it.
