# forum_to_md

Scrape **forum.jackkruse.com** (XenForo v2.x) into NotebookLM-ready markdown bundles + an Excel index.

The project takes a logged-in browser session (via cookies) and pulls every thread Jack Kruse has posted in, plus optionally every other thread on the forum. Output is split into three buckets:

Every extracted thread is packed chronologically into a series of NotebookLM-sized bundles:

| File | Contents |
|---|---|
| `processed_mds/forum#1.md`, `forum#2.md`, … `forum#N.md` | Every thread, sorted by first-post date. Each part ≤ **450 000 words / 190 MB**. Cumulative ≤ **25 M words / 50 files** (NotebookLM caps). |
| `processed_mds/forum-jackkruse-index.xlsx` | One row per discovered thread. Columns: `in_md` / `category` (jack / meet-and-greet / optimal-journal / not-jack) / `bundle_file` / `thread_file` / `id` / `title` / `subforum` / `sources` / `year` / first+last post date / post count / **word count** / jack post count / unique authors / extracted_at / url / keywords. |
| `processed_mds/threads/<slug>.<id>.md` | One MD per thread — source of truth for the bundles. |

## NotebookLM constraints

Each `forum#N.md` part is sized to fit inside NotebookLM's per-source limits with a safety margin:

| Limit | NotebookLM | Our cap |
|---|---|---|
| Words per source | 500 000 | **450 000** |
| Bytes per source | 200 MB | **190 MB** |
| Sources per notebook | 50 | **50** |
| Words per notebook | 25 000 000 | **25 000 000** |

Drop every `forum#N.md` straight into one NotebookLM notebook — no further trimming needed.

---

## How it works — four stages

```
[pinned-discover] ──┐
[jack-discover]   ──┤
[not-jack-discover] ┤  → threads.json (universe of every thread we've found)
                    │
                    ▼
              [extract]   → processed_mds/threads/<slug>.<id>.md  (one MD per thread)
                    │
                    ▼
                [split]   → forum-jackkruse-<YYYY>-Q<N>.md  (jack quarterly)
                            optimal-journal-threads.md
                            not-jack-threads.md
                            forum-jackkruse-index.xlsx
```

### 1. Discovery — find every thread URL

Three independent discovery modes, each writes into the shared `threads.json`:

- **`pinned-discover`** (`code/discover.js`): walks the forum index → enumerates every leaf subforum → on each subforum's page 1, harvests stickied threads (the icon `.structItem-status--sticky` or container `.structItemContainer-group--sticky`). Fast — ~1 min for 30 subforums.

- **`jack-discover`** (`code/jack-discover.js`): finds every thread Jack Kruse has posted in. Two phases:
  - **Phase 1** — *date-chain*. Posts a XenForo advanced-search constrained to user=Jack Kruse, gets a search-session URL (e.g. `/search/123456/`), walks pagination via `?page=N`, bails after 80 consecutive all-known pages, then re-creates a new search session with `c[older_than]=<oldest seen>` and walks the next slice back in time. Continues until reaching Jack's join date (2012-03-15). ~3-5 hours for the full history.
  - **Phase 2** — *per-subforum*. For each of the 30 subforums, posts a search with `c[users]=Jack&c[nodes]=<id>` to harvest threads Jack posted in from a different angle. Catches threads missed when Phase 1 burst-walked through known territory. ~30 min.

- **`not-jack-discover`** (`code/not-jack-discover.js`): exhaustive walk. For each subforum (or a `--subforums=<id,id>` subset), pages through every thread-list page, harvests every thread URL. Adds to `threads.json` only the ones not already discovered. ~30 min for the full forum.

`threads.json` schema per entry:
```json
{
  "id": 32507,
  "url": "https://forum.jackkruse.com/threads/the-human-gps-system....32507/",
  "title": "The Human GPS System Defines How Systems Operate in Humans",
  "subforum": "Optimal Reset",
  "sources": ["pinned", "jack-contributed"],
  "discovered_at": "2026-05-11T11:30:53.089Z",
  "extracted": true,
  "extracted_at": "2026-05-11T11:47:11.594Z",
  "extracted_run_id": "extract-v2-2026-05-11",
  "extracted_post_count": 28
}
```

`sources` is a union — a thread can be both pinned AND a jack-contributed result. All discovery modes use **merge-on-persist**: they re-read the file before write, union sources, preserve `extracted=true` flags. Multiple discover processes can run in parallel safely.

### 2. Extract — fetch every thread

`code/extract.js` reads `threads.json`, filters to entries with `extracted=false`, and for each one:

1. Fetches page 1 of the thread.
2. Reads pagination (`.pageNav-jump--last` href / `.pageNav-page` max) to know total pages.
3. Fetches page 2..N (sequential per thread; CONCURRENCY=3 threads in parallel).
4. Parses each `article.message--post` block via Cheerio for `{postId, author, dateIso, permalink, bodyHtml}`.
5. Converts post body HTML → markdown via Turndown (ATX headings, `-` bullets, fenced code, images stripped, XenForo "Click to expand…" triggers stripped).
6. Drops posts whose body markdown is shorter than `MIN_POST_BODY_CHARS` (default 20) — kills `+1` / emoji-only reactions.
7. Writes a single per-thread MD to `processed_mds/threads/<slug>.<id>.md`.
8. Updates `threads.json`: `extracted=true`, `extracted_at`, `extracted_run_id`, `extracted_post_count`.

If a fetch hits XenForo's login page (HTTP 403 or `data-template="login"` with `data-logged-in="false"`), extract throws `CookiesExpiredError`, persists progress, and exits with code 2. Re-running `npm run extract` after refreshing cookies resumes from where it stopped — every thread already marked `extracted=true` is skipped.

### 3. Split — aggregate per-thread MDs into bundles + xlsx

`code/split-and-index.js` reads every `processed_mds/threads/<id>.md`, parses each for `{title, subforum, postCount, jackPosts, firstDate, lastDate, uniqueAuthors}`, and classifies each thread:

- `jack` if `jackPosts > 0` OR `sources` includes `pinned` → quarterly bundle by `firstDate` year + quarter (month-split inside the quarter if >8 MB).
- `optimal-journal` if subforum is *My Optimal Journal* AND not jack → one big `optimal-journal-threads.md`.
- `not-jack` otherwise → one big `not-jack-threads.md`.

It also rebuilds `forum-jackkruse-index.xlsx`. Three categories together cover every extracted thread. The xlsx **Summary** sheet shows aggregates per source × category.

### Per-thread MD format

```markdown
══════════════════════════════════════════════════════════════════════
# Thread: <Thread title>
**Thread URL:** <https://forum.jackkruse.com/threads/<slug>.<id>/>
**Subforum:** <Subforum name>
**Posts:** <N>
══════════════════════════════════════════════════════════════════════

### <Author> — <ISO 8601 date>
**Source:** <https://forum.jackkruse.com/threads/<slug>.<id>/post-<NNNNN>>

<body markdown — including > [Username said:](permalink) blockquotes for quoted replies>

### <Next Author> — <Next ISO date>
**Source:** <permalink>

<body>
```

Bundles are simply concatenated per-thread MDs with a YAML preamble. The 70-char `═══...` separator is unique enough for any future re-split.

---

## Run

```sh
# Full jack pipeline (pinned merge → jack-discover P1+P2 → extract → split):
npm start

# Individual stages:
npm run discover            # pinned only
npm run discover-jack       # jack-contributed only
npm run discover-not-jack   # every subforum's full thread list (all not-jack-classified threads)
npm run discover-not-jack -- --subforums=17           # ONLY Optimal Journal (node 17)
npm run discover-not-jack -- --subforums=50,48,46,34  # specific subforums

npm run extract             # process every thread.extracted=false
npm run extract -- --limit=10  # smoke-test first 10 pending threads
node main.js --extract-only --shard=0/3   # shard 0 of 3 parallel extracts (run all 3 in parallel)

npm run split               # rebuild bundles + xlsx + monster.md from per-thread MDs
npm run recover             # one-shot: rebuild threads.json from per-thread MDs (if threads.json got wiped)
npm run status              # one-shot live status
```

### Monitoring

Two log files in `logs/`:
- **`logs/progress.log`** — sparse: one row on stage START / END / COOKIES_EXPIRED, plus a TICK row every 30 minutes during long runs. Captures the universe state (threads_total, extracted, pending, source counts, md_files, bundle_files).
- **`logs/workers.log`** — dense: one row per running worker every 1 minute, plus START and END rows per worker. Columns: `ts | event | stage | pid | elapsed | threads_done | posts | pages | failed`.

Plus an on-demand status command:

```sh
npm run status   # one-shot snapshot of threads.json, MD count, live procs, last 5 progress events
tail -f logs/workers.log     # watch every-1-min worker rows
tail -f logs/progress.log    # watch every-30-min progress + key events
```

Detailed per-fetch logs (every `GET 200 …KB ...` line) are console-only. They DO NOT write to disk. Logs stay small.

### Parallelism

Each discover/extract process is independent and threads.json-merge-safe. You can run several at once for speedup. Example:

```sh
npm run discover-jack            > log-jack.log &
npm run discover-not-jack -- --subforums=17  > log-oj.log &
npm run discover-not-jack -- --subforums=50,48,46,34  > log-big.log &
# Wait for all, then:
npm run extract
npm run split
```

Be mindful of forum rate-limiting — 4-5 processes at a time has been fine; 10+ may trigger 429s.

---

## Cookies

The forum is mostly walled — every URL returns the XenForo login template unless an `xf_session` cookie is present. **Cookies are NOT hard-coded in the repo.** You provide your own logged-in session via `cookies.txt` (gitignored) or the `XENFORO_COOKIE` environment variable.

**Full step-by-step in [SETUP.md](SETUP.md).** Short version:

1. Sign up at https://forum.jackkruse.com (free account is fine for public threads).
2. Log in in Chrome → F12 → Application → Cookies → `https://forum.jackkruse.com` → copy `xf_user`, `xf_csrf`, `xf_session` values.
3. Copy `cookies.txt.example` to `cookies.txt` and paste the three values in.
4. Run `npm run status` — should report `live procs` cleanly.

Cookie lifetime varies (hours to days). Pipeline detects expiry mid-run, persists progress, exits cleanly. Refresh cookies and re-run — already-extracted threads are skipped.

---

## File layout

```
forum_to_md/
├── README.md                            (this file)
├── SETUP.md                             step-by-step cookie setup for new users
├── CLAUDE.md                            run instructions + design notes for AI assistants
├── cookies.txt.example                  template — copy to cookies.txt and fill in (gitignored)
├── .gitignore                           excludes cookies, generated outputs, node_modules, logs
├── package.json                         ESM, deps: cheerio, turndown, turndown-plugin-gfm, p-limit, xlsx, playwright
├── settings.js                          UA, delays, retries, Jack member id, separator (cookies loaded from cookies.txt at runtime)
├── threads.json                         GENERATED — universe of every discovered thread
├── main.js                              CLI entry; dispatches stages by flag
├── code/
│   ├── discover.js                      pinned discover (sticky threads across subforums)
│   ├── jack-discover.js                 jack-contributed discover (Phase 1 date-chain + Phase 2 per-subforum)
│   ├── not-jack-discover.js             exhaustive subforum walk (filtered by --subforums flag)
│   ├── extract.js                       fetches threads, writes per-thread MDs, marks extracted=true
│   ├── split-and-index.js               aggregates per-thread MDs → bundles + xlsx; jack/oj/not-jack classification
│   ├── xenforo.js                       pure XenForo HTML parsing primitives (Cheerio + Turndown)
│   ├── http.js                          shared fetch wrapper with cookie + timeout + retry + login-redirect detection
│   ├── url-utils.js                     URL normalization, thread/subforum URL detection, slug-based filenames
│   ├── cleanup.js                       deletes prior dated bundle MDs before rewrite
│   ├── recover-threads-json.js          one-shot: rebuild threads.json from per-thread MDs
│   └── logger.js                        timestamped console + file logger (logs/<stage>_<runStamp>.log)
├── logs/                                per-run log files
└── processed_mds/                       GENERATED outputs:
    ├── threads/<slug>.<id>.md           one MD per thread
    ├── forum-jackkruse-<YYYY>-Q<N>.md   quarterly jack bundles
    ├── optimal-journal-threads.md       all Optimal Journal threads w/o Jack
    ├── not-jack-threads.md              all other no-Jack threads
    └── forum-jackkruse-index.xlsx       one row per thread, columns described above
```

---

## Design notes

- **Discovery and extraction are decoupled.** Discovery is cheap (~1 fetch per 20 threads). Extraction is expensive (~1 fetch per page × ~3 pages/thread). Splitting them means a discover failure doesn't waste extracts, and an extract failure doesn't waste discovery.
- **Per-thread MD as source of truth.** Every per-thread MD can be reproduced from forum HTML; every bundle can be reproduced from per-thread MDs. Re-running `split` regenerates bundles + xlsx in seconds without re-fetching. Re-running `extract` skips threads already marked `extracted=true`.
- **Merge-on-persist for `threads.json`.** Every write re-reads the file, unions `sources` arrays, preserves `extracted=true`. Multiple discover/extract processes can write to `threads.json` simultaneously without losing each other's updates.
- **Atomic writes.** Each persist uses a per-process `threads.json.<pid>.tmp` file + `rename`, so a crashed write doesn't corrupt the JSON.
- **Quote preservation.** Turndown's default `<blockquote>` handler is used as-is; XenForo's "Click to expand…" trigger divs are stripped first. Each quoted reply renders as `> [Username said:](permalink) > <quoted body>`, so NotebookLM citations can link directly to the quoted-from post.
- **ISO 8601 dates with timezone offset.** Pulled from `<time datetime="…">` attributes verbatim. Sortable, parseable.
- **Filename safety.** Slug from URL passes through `replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')` and truncates to 100 chars — Windows-safe.
- **Permissive failure handling.** A single malformed post inside a thread is caught and skipped (try/catch around `parsePost`); the thread still extracts with the rest of its posts.
- **`MIN_POST_BODY_CHARS=20`.** Drops `+1` / emoji-only / link-only replies that bloat the markdown without adding searchable content. Tune in `settings.js` if you want them back.

---

## Stats (snapshot 2026-05-13, full scrape complete)

After all pipelines:
- **19,800 threads** discovered in `threads.json`
- **19,799 extracted** (99.995%) — 1 permanently gated Inner-Circle thread
- 70 quarterly jack bundles
- 983 Meet and Greet threads in `meet-and-greet-threads.md`
- 466 My Optimal Journal threads in `optimal-journal-threads.md`
- 9,009 other no-jack threads in `not-jack-threads.md`
- `monster.md` — every thread in one file (~250-400 MB)
- `forum-jackkruse-index.xlsx` — 19,800 rows with `in_md / category / bundle_file / thread_file` columns

Forum has 30 subforums total, no nested children — all walked.
