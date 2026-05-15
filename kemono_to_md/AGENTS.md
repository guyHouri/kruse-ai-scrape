# kemono_to_md

Text-only crawler for the Kemono mirror of Dr. Jack Kruse Patreon posts.
This project-part is intentionally separate from `forum_to_md/`; do not modify
the XenForo crawler to support this site.

## Run

- `npm start` - discover posts, extract pending posts, rebuild `blog_series`, convert local PDFs, then write NotebookLM `blogs*.md` bundles.
- `npm run discover` - refresh `articles.json` from the Kemono API list pages.
- `npm run extract` - fetch pending post detail JSON and write per-article markdown.
- `npm run organize` - rebuild `processed_mds/blog_series/` from extracted API articles.
- `npm run convert-pdfs` - convert `processed_mds/blog/**/*.pdf` into markdown under `processed_mds/blog_series/`.
- `npm run bundle` - rebuild final NotebookLM `blogs.md` / `blogs-N.md` bundles from `blog_series`.
- `node main.js --extract-only --limit=N` - smoke-test extraction on N pending posts.

## Safety boundary

Kemono hosts adult creators, so this crawler must remain text-only:

- Do not use browser automation or screenshots.
- Do not download files, images, previews, videos, attachments, or thumbnails.
- Do not persist attachment/media metadata or media URLs.
- Strip `img`, `video`, `audio`, `picture`, `source`, `iframe`, `svg`, and links
  to `/data/`, thumbnail paths, and common media extensions from markdown.
- Logs must not print article bodies. Prefer IDs/counts/status over content.

## Storage

- `articles.json` is the resumable queue. It contains post metadata only.
- `processed_mds/articles/<published-date>-<id>.md` is one text-only article file.
- `processed_mds/blog/` is the manually supplied local PDF input folder.
- `processed_mds/blog_series/<SERIES>/<SERIES>#<N>.md` is the organized working set for API articles and converted PDFs. Examples: `CPC/CPC#75.md`, `DM/DM#42.md`, `BTC/BTC#1.md`.
- `processed_mds/blogs.md` or `processed_mds/blogs-N.md` are final NotebookLM bundles. The bundler targets under 190MB and under 490,000 words per file, below NotebookLM's 200MB / 500,000-word source limits.

Every generated markdown article includes a `**Source:**` line pointing back to
the public Kemono post URL. PDF conversions include a `**Source PDF:**` path.

## Series routing

Known series are normalized to compact folder/file names:

- `DECENTRALIZED MEDICINE`, including common spelling variants, -> `DM`
- `CPC` -> `CPC`
- `QT` -> `QT`
- `HYPOXIA` -> `HYPOXIA`
- `BTC` / `BITCOIN` -> `BTC`
- unknown numbered all-caps prefixes become their own series
- all other one-off posts go to `OTHER`
