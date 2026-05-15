# AGENTS.md — kruse-ai-scrape

Context doc for AI assistants (Claude, Cursor, Codex, etc.) working in this repo. Humans should read [`README.md`](README.md) first.

## What this project is

`kruse-ai-scrape` is a collection of independent Node.js scrapers that pull Jack Kruse's content from various sources and emit NotebookLM-ready markdown bundles. Each scraper is a self-contained module under the repo root.

| Module | Source | Status | Output |
|---|---|---|---|
| [`forum_to_md/`](forum_to_md/) | `forum.jackkruse.com` (XenForo v2.x forum, logged-in) | **working** | `forum#1.md`..`forum#N.md` (chronological pack) + category bundles + per-thread MDs + xlsx index |
| [`kemono_to_md/`](kemono_to_md/) | Kemono Patreon mirror + local PDFs | working | `blogs-*.md` series bundles + per-article MDs |
| [`threadreader_to_md/`](threadreader_to_md/) | Thread Reader App `/user/DrJackKruse` | working | `tweet-threads*.md` bundles + per-thread MDs |
| [`linkedin_to_md/`](linkedin_to_md/) | LinkedIn post archive (xlsx-driven) | in progress | TBD |
| [`website_to_md/`](website_to_md/) | Generic web scraper (Cheerio + Turndown) | **legacy / reference** | One `website-<slug>-<date>.md` per site. Every other module was built on top of this codebase's patterns. |

`website_to_md/` is NOT a module in the same sense as the others — it's the original general-purpose web scraper. The forum/kemono/threadreader/linkedin modules were derived from its design (two-stage discover/extract, Cheerio + Turndown rendering, per-source `.md` output). Keep it tracked for reference but do not extend it for new sources — fork into a new sibling module instead.

## NotebookLM constraints (apply to every module)

Every bundle file targets these caps so it drops straight into a [NotebookLM](https://notebooklm.google.com/) notebook:

| Cap | NotebookLM hard limit | Our target |
|---|---|---|
| Words per source | 500 000 | 490 000 |
| Bytes per source | 200 MB | 195 MB |
| Sources per notebook | 50 | (informational — not enforced; project also serves non-NotebookLM consumers) |
| Words per notebook | 25 000 000 | (informational) |

If a single thread/post exceeds the per-file word cap on its own, it gets its own oversized file rather than being split mid-content.

## Standard module layout

Every module follows the same shape so contributors can move between them quickly:

```
<module>/
├── README.md            human-facing run instructions
├── SETUP.md             credential capture step-by-step (cookies / API keys)
├── CLAUDE.md            (optional) AI-assistant-facing dev doc; same content as AGENTS.md if present
├── package.json         ESM, own deps, own author block
├── settings.js          tunables (cookies path, UA, delays, retries, paths, output caps)
├── main.js              CLI entry — run via `npm start`
├── code/                pure JS modules — discover/extract/parse/split/log
├── cookies.txt.example  template for credentials (real cookies.txt is gitignored)
├── processed_mds/       GENERATED output (gitignored)
└── logs/                runtime logs (gitignored)
```

Conventions:

- **Credentials never in code.** Each module reads `XENFORO_COOKIE` (or analog) from a local gitignored `cookies.txt` or env var. See each module's `SETUP.md`.
- **Per-item file = source of truth.** Each discovered item gets its own `processed_mds/<subdir>/<slug>.<id>.md`. Bundles aggregate these — bundles are derived, per-item files are canonical.
- **Resumable.** State is persisted in a JSON file at module root (`threads.json`, `articles.json`, etc.) with an `extracted: true/false` flag per item. Re-running an extract skips already-done items.
- **Atomic threads.json writes** with merge-on-persist: parallel discover/extract processes can write without losing each other's updates. See `forum_to_md/code/extract.js:persistThreads()` for the pattern.
- **One shared log file per module.** `logs/progress.log` (every 30 min + key events) and `logs/workers.log` (every 1 min per worker). No per-run log files.

## Working in this repo as an AI assistant

- Run `npm run status` inside any module to get a live state snapshot — threads/items count, MDs on disk, live procs, last 5 progress events.
- Don't read files in `processed_mds/`, `logs/`, `node_modules/` unless explicitly asked — they're large and rarely useful.
- Cookies have varying lifetime per source. When you see `HTTP 403` or `data-template="login"` markers, the cookie expired — refresh procedure is in each module's `SETUP.md`.
- Output bundles are gitignored. You regenerate them via `npm run split` (or equivalent). Per-item files persist between runs.

## Adding a new module

1. Copy `forum_to_md/` as a starter and rename.
2. Replace `settings.js` tunables.
3. Adapt `code/discover.js` + `code/extract.js` to the new source's HTML/API.
4. Keep the same output convention: `processed_mds/<subdir>/<slug>.<id>.md` + bundle aggregator + xlsx index.
5. Add a row to the module table in this file and in `README.md`.
6. Write its `SETUP.md` (credential capture) and `README.md` (run instructions).

## Authors

- **Guy Houri** — [guyhouri.tech@gmail.com](mailto:guyhouri.tech@gmail.com)
- **Amit Streit**
