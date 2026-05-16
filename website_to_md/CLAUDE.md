# website_to_md — legacy reference scraper

**Status:** legacy / reference codebase. NOT a kruse-ai-scrape module. Every other module (`forum_to_md/`, `linkedin_to_md/`, `free_blogs_md/`, `threadreader_to_md/`, `private/kemono_to_md/`) was built on top of this code's patterns and conventions, but they are independent now.

`websites.json` is intentionally empty (`[]`). The repo previously held Hebrew Australian-tourism site entries from the original fork; they were scrubbed when this project was repurposed for the Jack Kruse corpus. Add new entries here only if you actually need an article-portal scraper for a Kruse-related site — otherwise fork a new sibling module.

Generic two-stage web scraper: crawl same-domain URLs, render each page to markdown via Cheerio + Turndown. Useful as a starter template for new sources where the target is article-portal-style content (one URL = one article).

## Run

```sh
cd website_to_md
npm install
npm start                  # crawl + extract for every is_active site in websites.json
npm run crawl              # discovery only
npm run extract            # render markdown from previously-crawled link lists
npm start <slug>           # process one specific site (bypasses is_active filter)
```

## Design notes (kept for reference)

- **Site list in `websites.json`:** `{ slug, seedUrl OR seedUrls[], maxDepth, is_active }`. Multi-seed entries share a registrable host (first seed = host anchor). `slug` is the filesystem identity for `links/<slug>.txt` and `processed_mds/website-<slug>-<date>.md`.
- **Two-stage decoupling.** Crawler discovers same-registrable-host URLs up to `maxDepth` and writes one links file per site. Extractor reads those, fetches each, runs Cheerio + Turndown, writes one `.md` per site. Stages share no in-memory state — re-extract doesn't require re-crawl.
- **Boilerplate stripping (load-bearing order):**
  1. `stripGlobalBoilerplate` — kill nav/footer/script/style tags wholesale.
  2. `pickContentRoot` — find main content via `article` / `main` / `.entry-content` / etc.
  3. `stripInlineBoilerplate` — class/id token blocklist for comments, share bars, related-posts.
- **Output filename:** `website-<slug>-<YYYY-MM-DD>.md`. Older dated files for the same slug are deleted before write.
- **`**Source:**` line per article** preserves the original URL inside each chunk.

## Code patterns reused by other modules

- `code/url-utils.js` — URL normalization, registrable-host comparison, slug generation. Forum/kemono/threadreader URL utils derived from this.
- `code/extractor.js` orchestration + `code/extract.js` rendering split — same pattern as `forum_to_md/extract.js` (orchestration) + `forum_to_md/xenforo.js` (parsing).
- Cheerio + Turndown HTML → markdown pipeline with `stripImages` rule — copied into every module.
- `code/logger.js` — same per-run log file pattern (later replaced by a single-shared-file logger in `forum_to_md`).

## Why not extend this for new sources

This codebase is calibrated for **article-portal** sites (one URL = one article). Forum threads, paginated content, API-driven mirrors, etc. need different orchestration. Fork a new sibling module instead — see [`forum_to_md/code/`](../forum_to_md/code/) for an example.

## Don't read into chat unless explicitly asked

- `processed_mds/*.md` — generated, large
- `links/*.txt` — one per crawled site, can be MB-scale
- `logs/*.log` — per-run diagnostics
