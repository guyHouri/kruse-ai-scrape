# kruse-ai-scrape

Scrape Dr. Jack Kruse's content from across the web into NotebookLM-ready markdown bundles. Built so the entire body of his work can be fed into a single [NotebookLM](https://notebooklm.google.com/) notebook (or any RAG system / search index) and queried as one knowledge base.

Each source has its own self-contained Node.js scraper under this repo root. Modules share nothing — they're independent pipelines that produce their own per-item markdown + bundle aggregations + Excel index.

```
kruse-ai-scrape/
├── forum_to_md/            forum.jackkruse.com (XenForo) — 19,800 threads, ~25M words
├── kemono_to_md/           Kemono Patreon mirror + local PDFs (Jack's blogs)
├── threadreader_to_md/     Thread Reader App / X tweet-thread archive
├── linkedin_to_md/         LinkedIn post archive (xlsx-driven)
├── website_to_md/          LEGACY general-purpose scraper — other modules built from its patterns
├── docs/sources.md         knowledge-source index (priority + difficulty per source)
├── AGENTS.md               AI-assistant-facing project context (also linked as CLAUDE.md)
├── README.md               this file
└── LICENSE                 MIT
```

## Data sources

Every scraping target is documented in [`docs/sources.md`](docs/sources.md). Quick summary, ranked by signal-to-noise and ETL difficulty:

| Source | Priority | Difficulty | Format | Module |
|---|---:|---|---|---|
| Q&A & PowWows (2012–2026) | 10 / 10 | High | MP3 → STT (Whisper + diarization) | _planned_ |
| Forum comments & discussions | 9 / 10 | Medium-High | Web / HTML scraping | [`forum_to_md/`](forum_to_md/) ✅ |
| X (Twitter) posts & threads | 7 / 10 | Medium | JSON / API | [`threadreader_to_md/`](threadreader_to_md/) ✅ |
| Podcast transcripts | 6 / 10 | Medium | Audio / CSV | _planned_ |
| Blog posts (Patreon / science backlog) | 4 / 10 | Low-Medium | HTML / PDF | [`kemono_to_md/`](kemono_to_md/) ✅ |
| LinkedIn & FB articles | 3 / 10 | Low | Static links | [`linkedin_to_md/`](linkedin_to_md/) 🚧 |

For per-source priority, technical notes, and external archive links (Terabox, Google Sheets, etc.) see [`docs/sources.md`](docs/sources.md).

## NotebookLM constraints

Every bundle file targets these caps so it drops straight into a NotebookLM notebook:

| Limit | NotebookLM (hard) | Our target (per file) |
|---|---|---|
| Words per source | 500 000 | 490 000 |
| Bytes per source | 200 MB | 195 MB |

File **count** is intentionally unbounded — this project also serves grep / full-archive use cases. If you're loading into a NotebookLM notebook (50-source / 25 M-word cap), pick the highest-priority bundles for your query — see the `category` column in each module's xlsx index.

## Quick start

```sh
git clone https://github.com/guyhouri/kruse-ai-scrape.git
cd kruse-ai-scrape/forum_to_md

# 1. Install
npm install

# 2. Capture cookies (see forum_to_md/SETUP.md)
cp cookies.txt.example cookies.txt
# edit cookies.txt with your xf_user / xf_csrf / xf_session values

# 3. Run
npm start              # discover → extract → split (~2-3 hr cold start)
npm run status         # live snapshot of progress
```

Full instructions in [`forum_to_md/README.md`](forum_to_md/README.md) and [`forum_to_md/SETUP.md`](forum_to_md/SETUP.md). Other modules follow the same shape — see their `SETUP.md` for source-specific credential capture.

## Module status

| Module | Source | State | Output |
|---|---|---|---|
| [`forum_to_md/`](forum_to_md/) | `forum.jackkruse.com` | **working** — 19,800 threads, 21+ M words | `forum#1.md`..`forum#N.md` + `jack-threads-*.md` + category bundles + per-thread MDs + xlsx |
| [`kemono_to_md/`](kemono_to_md/) | Kemono Patreon mirror | **working** | `blogs-*.md` series + per-article MDs |
| [`threadreader_to_md/`](threadreader_to_md/) | Thread Reader App | **working** | `tweet-threads*.md` + per-thread MDs |
| [`linkedin_to_md/`](linkedin_to_md/) | LinkedIn xlsx archive | 🚧 in progress | — |
| [`website_to_md/`](website_to_md/) | Generic web scraper | **legacy / reference** | One MD per site — kept for posterity |

`website_to_md/` is the original general-purpose scraper that every other module was built from. It's not part of the kruse content set — keep it tracked for reference only. New sources should fork into a new sibling module, not extend this codebase.

## Authors

- **Guy Houri** — [guyhouri.tech@gmail.com](mailto:guyhouri.tech@gmail.com)
- **Amit Streit**

## License

[MIT](LICENSE) — attribution appreciated.
