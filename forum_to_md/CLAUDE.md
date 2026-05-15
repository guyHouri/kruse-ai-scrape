# forum_to_md — AI assistant notes

Public docs: [`README.md`](README.md) for run instructions, [`SETUP.md`](SETUP.md) for cookie capture.

Two-stage pipeline scraping `forum.jackkruse.com` (XenForo v2.x). Per-thread MDs are the source of truth; bundles are derived. See root [`AGENTS.md`](../AGENTS.md) for project-wide conventions.

## Stages (chained by `npm start`)

1. **pinned-discover** — walks every subforum index, harvests stickied threads.
2. **jack-discover** — chains XenForo search sessions to find every thread Jack posted in (Phase 1 date-chain, Phase 2 per-subforum).
3. **not-jack-discover** — exhaustive subforum walk. Optional `--subforums=<id,id>` to scope.
4. **extract** — fetches every thread with `extracted=false`, writes per-thread MD to `processed_mds/threads/<slug>.<id>.md`, marks `extracted=true` in `threads.json` (atomic merge-on-persist).
5. **split** — reads per-thread MDs + `threads.json`, emits the bundle set + xlsx index.

## Bundles produced by split

- **`forum#1.md`..`forum#N.md`** — every extracted thread, chronological by first-post date. Capped at 490 k words / 195 MB per file. No cap on file count — adapts to content size.
- **`jack-threads-1.md`..`jack-threads-N.md`** — every thread Jack participated in (jack_post_count > 0 OR sources includes `pinned`).
- **`monster-1.md`..`monster-N.md`** — alias of `forum#N.md` for backward compat with consumers expecting that name.
- **`meet-and-greet-threads.md`** — *Meet and Greet* subforum, no Jack.
- **`optimal-journal-threads.md`** — *My Optimal Journal* subforum, no Jack.
- **`not-jack-threads.md`** — all other no-Jack threads.
- **`forum-jackkruse-index.xlsx`** — one row per discovered thread with `in_md`, `category`, `bundle_file`, `thread_file`, `post_count`, `word_count`, `jack_post_count`, etc.

## Code layout

| File | Purpose |
|---|---|
| `code/discover.js` | Pinned (sticky) thread harvesting |
| `code/jack-discover.js` | Search-session chain for threads Jack posted in |
| `code/not-jack-discover.js` | Exhaustive subforum thread-list walk |
| `code/extract.js` | Per-thread fetch + parse + write MD; resumable via `extracted=true` flag |
| `code/split-and-index.js` | Bundle aggregation + xlsx + legacy MD migration |
| `code/xenforo.js` | Pure HTML parsers: subforum index, sticky threads, thread page, pagination |
| `code/http.js` | Shared fetch wrapper: cookie injection, timeout, retry, login-redirect detection |
| `code/url-utils.js` | URL normalization, thread-URL detection, slug-based filenames |
| `code/cleanup.js` | Deletes prior bundle MDs before rewrite |
| `code/recover-threads-json.js` | One-shot rebuild of `threads.json` from per-thread MDs (after a wipe) |
| `code/status.js` | `npm run status` — live snapshot for monitoring |
| `code/progress-log.js` | Single shared `logs/progress.log` (30-min ticks) + `logs/workers.log` (1-min per worker) |
| `code/logger.js` | Console output (no per-line file writes — keeps log volume small) |

## Cookie expiry handling

When `xf_session` expires mid-run, fetches return HTTP 403 with `data-template="login"`. `http.js` flags this as `loginRedirect: true`. Extract / discover propagate as `CookiesExpiredError`, persist progress, exit code 2. Re-run after refreshing `cookies.txt` — already-extracted threads are skipped via `extracted=true` flag.

Plain HTTP 403 (no login template) = gated thread (Inner Circle / members-only). Skip silently, continue with next thread.

## Don't read into chat unless asked

- `processed_mds/**/*.md` — large
- `logs/*.log` — large, use `npm run status` or grep
- `threads.json` — ~19k entries, can be MB-scale
