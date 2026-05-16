# Future Improvements — kruse-ai-scrape

Roadmap for upcoming work. Each item is a self-contained mini-plan; nothing here is implemented yet. Pick one off the list, read the plan, build it.

> **Tracking:** these are mirrored as GitHub Issues on https://github.com/guyHouri/kruse-ai-scrape/issues so anyone can subscribe or claim one. This file stays the canonical narrative — issues link back here.

---

## 1. Weekly auto-update job (Patreon + forum delta)

### Why

Jack publishes constantly. A static snapshot ages fast. NotebookLM should ingest the new stuff weekly without a human re-running every module by hand.

### Scope

Two upstream sources change weekly:

1. **`forum.jackkruse.com`** — new threads (and new posts in tracked threads). The hard one.
2. **Patreon** ([patreon.com/DrJackKruse](https://www.patreon.com/DrJackKruse)) — gated, ~$20/mo tier. New posts arrive weekly.

LinkedIn Pulse is monthly-or-slower; bundle into the same job opportunistically.

The free blog (jackkruse.com) updates rarely now — out of scope for weekly; revisit quarterly.

### Architecture

```
weekly_updater/                          NEW module
├── cron.md                              setup doc: Windows Task Scheduler / GitHub Actions cron
├── settings.js                          forum cookie + Patreon cookie, source list
├── main.js                              orchestrates all sources, writes weekly delta bundle
├── code/
│   ├── forum-delta.js                   re-discover jack-threads + extract NEW posts only
│   ├── patreon-delta.js                 Playwright headed login (Patreon) + harvest posts
│   ├── linkedin-delta.js                wraps linkedin_to_md discover, skips already-extracted
│   ├── delta-state.json                 watermark per source (last seen post id / date)
│   └── bundler.js                       packs weekly delta into kruse-weekly-YYYY-WW.md
└── processed_mds/
    └── weekly/                          rolling history of weekly bundles
```

### Forum delta strategy

The current `forum_to_md/code/jack-discover.js` walks all 19,800 threads. For weekly mode:

- Read `threads.json` (existing universe).
- Crawl `/whats-new/posts/` (XenForo built-in "recent posts" feed) — single paginated page, ~200 posts.
- Filter posts authored by Jack (member id 1031). Extract thread id from each.
- For each tracked thread: re-fetch ONLY the last page (XenForo highest page first), parse posts dated after the watermark.
- Append new posts to existing per-thread MD in `forum_to_md/processed_mds/threads/<id>.md`.
- Update `threads.json` watermark fields (`last_seen_post_id`, `last_seen_at`).

Side benefit: also picks up new threads where Jack posted (since they'll appear in `/whats-new/posts/`).

### Patreon delta strategy

Patreon hides everything behind login + paid-tier gate. Playwright headed flow (mirror linkedin_to_md/code/discover.js):

1. Headed Chromium → patreon login (creds in `credentials.txt`).
2. Solve any 2FA in the visible browser.
3. Navigate to `https://www.patreon.com/c/DrJackKruse/posts` (paywalled feed).
4. Scroll-to-bottom infinite-scroll harvest (same pattern as linkedin discover).
5. For each post URL: fetch with the session cookie, parse `<article>` block, write per-post MD to `processed_mds/patreon/<post-id>.md`.
6. Watermark by `published_at` ISO date; skip already-extracted posts on subsequent runs.

**Subscription required** — repo doesn't ship credentials; SETUP.md notes that anyone running this needs their own Patreon membership.

### Scheduling

- **Windows Task Scheduler:** `cron.md` walks the user through creating a weekly task that runs `node weekly_updater/main.js`. Logs to `weekly_updater/logs/cron.log`.
- **GitHub Actions** (optional): a workflow on a `schedule:` cron firing once a week, committing the new MDs back to the repo. Caveat: secrets (cookies) live in Actions secrets; cookies expire weekly to monthly so a human still has to refresh them. Honestly the local Task Scheduler is more reliable until someone wants to babysit Actions secrets.

### Output

`weekly_updater/processed_mds/weekly/kruse-weekly-2026-W21.md` — one file per ISO week, format:

```markdown
---
slug: jackkruse-weekly
week: 2026-W21
generated_at: 2026-05-23T08:00:00Z
forum_new_posts: 47
patreon_new_posts: 3
linkedin_new_articles: 0
---

# Jack Kruse — Week 2026-W21

═══════════════════════════════════════════════════════════════════════

## Forum: 47 new posts (Jack)

...
═══════════════════════════════════════════════════════════════════════

## Patreon: 3 new posts

...
═══════════════════════════════════════════════════════════════════════

## LinkedIn: 0 new articles
```

User uploads this single file to NotebookLM as a new source each week. Old weekly bundles stay in the folder for re-ingestion / RAG indexing.

### Open questions to settle before building

- Should weekly MDs be appended into the forum bundles (re-pack `forum#N.md`) or stay as standalone weekly snapshots? **Recommendation:** standalone — re-packing is expensive and breaks NotebookLM citation continuity.
- Patreon ToS: scraping your own paid content is murky. Document this in SETUP.md, ship the code, user is responsible.

### Estimated effort

- Forum delta: 1 day (re-uses existing parser, just adds whats-new walk + watermark)
- Patreon delta: 2 days (new module, login flow + parser)
- Cron + bundler glue: 0.5 day
- **Total: ~3.5 days**

### Operating cost (per week of running)

| Item | Cost |
|---|---|
| Patreon subscription (Dr Jack Kruse tier) | ~$20 / month — required to scrape paid posts |
| Compute (local Windows machine, ~15 min/week) | electricity, negligible |
| Bandwidth (forum delta + Patreon delta) | ~50 MB / week — negligible |
| Storage (rolling weekly bundles) | ~5 MB / week, ~250 MB / year — negligible |
| GitHub Actions (if used instead of local cron) | free tier covers 2,000 minutes/month — well under |
| **Monthly total** | **~$20** (just Patreon) |

If skipping Patreon (forum + LinkedIn only): **$0/month**.

---

## 2. Q&A audio → text → vector DB → RAG

### Why

Hundreds of GB of Jack Kruse Q&A audio (member calls, podcast interviews, etc.) — unsearchable, untranscribed. Convert to text, embed, build a chat RAG. This is the "wildest dream" feature; biggest payoff but biggest effort.

### Scope of source material

Inventory first (TODO — not done yet):

- Patreon member call recordings (paid tier)
- Podcast appearances (public — YouTube + various podcast feeds)
- Forum Q&A audio attachments (if any)
- Conference talks on YouTube
- The "Kruse Longevity Series" recordings

**Assume:** 500–1000 hours of audio total. At ~7,500 words/hour spoken = ~5M words. Same order of magnitude as the full forum corpus.

### Pipeline

```
qa_rag/                                   NEW module (multi-stage)
├── 1_inventory/                          one-time: catalog every audio source
│   ├── youtube_playlists.json
│   ├── patreon_audio.json
│   └── podcast_feeds.json
├── 2_download/
│   ├── yt-dlp + ffmpeg                  rip audio from YouTube
│   ├── patreon-dl.js                    custom downloader for Patreon audio
│   └── audio/<source>/<title>.mp3       canonical layout
├── 3_transcribe/
│   ├── whisper-cpp / faster-whisper     run locally (large-v3 model)
│   ├── transcripts/<source>/<title>.json  with word-level timestamps
│   └── transcripts/<source>/<title>.md  human-readable, timestamps as anchors
├── 4_embed/
│   ├── chunker.js                       semantic chunks ~500 tokens, 50-token overlap
│   ├── embed.py                         sentence-transformers OR OpenAI text-embedding-3-small
│   └── chroma_db/ OR qdrant/            local vector store, ~50GB
└── 5_rag_chat/
    ├── server.py                        FastAPI: retrieve top-k chunks + claude/gpt completion
    ├── web/                             minimal chat UI (vanilla JS, no React BS)
    └── eval/                            golden Q/A pairs to measure retrieval quality
```

### Stage-by-stage

**1. Inventory (1–2 days, mostly clicking)**

Build three JSON files listing every audio source. YouTube playlists are easiest (search "Jack Kruse podcast" → harvest channel + playlist URLs). Patreon needs the same scroll-harvest as the weekly updater. Podcasts: use Podchaser or just search "Jack Kruse interview podcast" and feed-by-feed.

**2. Download (1–2 weeks wall time, mostly bandwidth)**

- YouTube: `yt-dlp -x --audio-format mp3 <url>` in parallel batches. Bandwidth-bound, not CPU-bound.
- Patreon: needs session cookie + Playwright to extract direct audio URLs from each post.
- Resume-friendly: skip if `audio/<source>/<title>.mp3` exists.
- Storage: ~30 GB for 500h of audio at MP3 96kbps.

**3. Transcribe (the long pole — 1–4 weeks compute time)**

Use **faster-whisper** with `large-v3` model on GPU. RTX 4090 does ~5× realtime on large-v3. So 500 hours of audio → 100 hours of GPU time = ~4 days on a single 4090.

Output: JSON with word-level timestamps + plain MD with paragraph breaks. Save both.

**Cost alternative:** OpenAI Whisper API at $0.006/min = ~$180 for 500 hours. Faster wall clock (parallelizable, no GPU needed). Trade money for time.

**Quality watch:** Jack speaks fast, drops scientific terms (mitochondria, cytochrome, magnetoreception, etc.). Whisper large-v3 is solid on jargon but expect ~3% WER. Do NOT use whisper.cpp tiny/base — too noisy.

**4. Embed + index (1 day)**

- Chunk every transcript by sentence boundaries → ~500-token chunks, 50-token overlap.
- Metadata per chunk: `{source, title, start_ts, end_ts, chunk_idx, url}` — keep timestamps so we can deep-link back into the audio.
- Embedding model:
  - **Local (recommended for sovereignty):** `sentence-transformers/all-mpnet-base-v2` or `BAAI/bge-large-en-v1.5`. CPU OK.
  - **Hosted (best quality):** OpenAI `text-embedding-3-small` ($0.02 per 1M tokens; entire corpus ~$2).
- Vector store: **ChromaDB** for local-first simplicity. Or **Qdrant** if we ever need to scale or expose this over HTTP.
- Sanity check: random Jack quote → top-5 retrieval → must hit the right podcast within first result.

**5. RAG chat (1 week)**

Minimal FastAPI server:

```
POST /chat
  body: { question, history }
  -> retrieve top 8 chunks from vector DB
  -> render prompt: "You answer questions about Jack Kruse's teachings. Cite sources.
                     Context: <chunks>. Question: <q>"
  -> call Claude Sonnet 4.7 (or whatever's current) with the prompt
  -> stream response back with source citations
```

UI: vanilla JS chat. Don't ship a Next.js / React skeleton — overkill. Show the cited source titles + timestamp links inline.

**Eval set:** 50 hand-written Q/A pairs (questions Jack obviously answered in known recordings). Track top-1, top-5, top-10 retrieval accuracy + answer quality (human grading). Run eval on every embedding-model swap.

### Risks / open questions

- **Whisper accuracy on Jack's jargon:** test on 30 min sample first, decide if we need a fine-tune.
- **Storage:** 30 GB audio + 5 GB transcripts + 5 GB vector DB. Fine on a normal disk. NOT going in git — gitignore everything under `qa_rag/audio/`, `qa_rag/transcripts/raw/`, `qa_rag/chroma_db/`. Only the MD transcripts and source code get committed.
- **Patreon ToS:** same as weekly updater. Document, ship, user's responsibility.
- **YouTube Music / podcasts copyright:** transcripts of public podcasts ARE fair use for research, but redistributing the original audio is not. We commit transcripts, not audio.
- **Hardware:** if no local GPU, fall back to Whisper API. Document both paths in `qa_rag/CLAUDE.md`.

### Estimated effort

- Inventory: 1–2 days
- Download infrastructure: 2 days
- Transcription pipeline + run: 1 week (mostly waiting)
- Embedding + vector DB: 1 day
- RAG server + UI: 1 week
- Eval set + tuning: ongoing
- **Total: ~3 weeks of focused work + 1–2 weeks wall time for transcription**

### Operating cost

**One-time build cost:**

| Item | Local GPU path | Hosted API path |
|---|---|---|
| Transcription (Whisper large-v3, ~500 h audio) | ~$5 electricity (4 days on RTX 4090) | **~$180** (OpenAI Whisper API @ $0.006/min) |
| Embedding (~5 M words ≈ 6.5 M tokens) | $0 (local sentence-transformers, CPU) | **~$0.13** (OpenAI `text-embedding-3-small` @ $0.02 / 1M tokens) |
| Storage setup (30 GB audio + 5 GB transcripts + 5 GB vector DB) | ~$0 on local SSD | same |
| Hardware (if buying GPU just for this) | $1,500–$2,000 (used 4090) | $0 |
| **One-time total (already own GPU)** | **~$5** | **~$180** |
| **One-time total (no GPU, rent)** | ~$50 (Vast.ai 4090 ~$0.40/h × 100 h) | **~$180** |

**Ongoing cost per month (RAG chat in use):**

| Item | Free path | Paid path |
|---|---|---|
| LLM completions (Claude Sonnet 4.7 @ ~$3/1M input + $15/1M output, ~3K tokens/query) | n/a | ~$0.05 / query |
| 100 queries/month (light usage) | $0 (local Llama 3.1 70B on GPU) | **~$5** |
| 1,000 queries/month (heavy usage) | $0 (same) | **~$50** |
| Vector DB hosting | $0 local | $0 (ChromaDB is local, Qdrant local is also free) |
| Web UI hosting | $0 (run locally) | ~$5 (cheap VPS) if public |
| Re-transcribing new Q&A (weekly delta) | ~$0.10 electricity / hour added | ~$0.36 / hour added (API) |

**Realistic monthly bill if you want a hosted public RAG with API completions:** **~$10–60** depending on traffic.
**Realistic monthly bill for personal-use local RAG with own GPU:** **~$2** (electricity for occasional inference).

---

## 3. (Smaller wins — list, no detailed plans)

These are obvious follow-ups that don't deserve their own multi-page plan:

- **Forum cookie auto-refresh:** XenForo cookies die in ~1 hour. Add a Playwright login helper that refreshes `cookies.txt` automatically when extract hits a login redirect. Saves ~5 manual cookie pastes per full forum run.
- **Image extraction for forum posts:** currently stripped by Turndown rule. Jack often posts diagrams in forum posts. Download and embed if NotebookLM ever supports images (it does in some plans).
- **jackkruse.com paid blog scraper:** the free blog is in `free_blogs_md/`. The paid `/products/` posts are gated. New module mirroring `linkedin_to_md/` pattern with login.
- **X / Twitter threads:** `docs/sources.md` ranks X threads 7/10 priority. Currently no module. Plan: `nitter` mirror or paid API.
- **NotebookLM upload automation:** all bundles are produced; uploading is still manual via the web UI. NotebookLM has no public API but a Playwright headed flow could automate it.
- **Per-module skill packs** (Claude Skills): one skill per module that knows the run order + flags. Saves prompt tokens for routine maintenance.

---

## Tracking

Each numbered section above ↔ one GitHub Issue. Issue body links back to this file with a deep anchor. When work starts, branch name = `feature/N-short-name` (e.g. `feature/1-weekly-updater`). When it ships, the issue closes and the section here gets a `**Status:** Done in <commit-sha>` line at the top.

---

## Contributing

Read the relevant section above. Open an issue to discuss before writing code if the plan needs adjusting. PRs that diverge from the plan without discussion will be sent back. New ideas → new section here + new issue. Don't smuggle features in via unrelated PRs.
