# kemono_to_md

Text-only crawler and organizer for Dr. Jack Kruse Patreon/blog material from:

- Kemono API: `https://kemono.cr/patreon/user/6940816/`
- Local PDFs: `processed_mds/blog/**/*.pdf`

The forum crawler is untouched. This project-part has its own queue, adapter,
PDF converter, series organizer, and NotebookLM bundler.

## Commands

- `npm start` - full run: discover, extract, organize by series, convert PDFs, bundle.
- `npm run discover` - refresh `articles.json` from Kemono list pages.
- `npm run extract` - fetch pending post detail JSON into `processed_mds/articles/`.
- `npm run organize` - rebuild `processed_mds/blog_series/` from API article markdown.
- `npm run convert-pdfs` - convert local PDFs into markdown in `blog_series/`.
- `npm run bundle` - write NotebookLM bundles from `blog_series/`.

## Outputs

- `articles.json` - resumable metadata queue.
- `processed_mds/articles/` - original per-article markdown by date and post id.
- `processed_mds/blog_series/` - organized markdown by blog series.
- `processed_mds/blogs-1.md`, `blogs-2.md`, ... - NotebookLM upload files.

The old yearly `kemono-patreon-drjackkruse-YYYY.md` bundles are no longer used.

## NotebookLM Limits

The bundler splits on conservative limits:

- max file size target: 190MB, below the 200MB NotebookLM source limit
- max word target: 490,000 words, below the 500,000-word source limit

On the first full run, the combined API articles plus 108 converted PDFs produced
three files: `blogs-1.md`, `blogs-2.md`, and `blogs-3.md`.

## Media Safety

This pipeline is text-only by design.

- It uses JSON API requests and `pdftotext`; no browser automation.
- It does not download media files.
- It does not persist Kemono attachment, preview, video, or file metadata.
- It strips images, videos, audio, iframes, thumbnails, `/data/` links, and common media URLs from API article markdown.
- PDF conversion extracts text only; embedded PDF images are not exported.

## Series Naming

The organizer writes compact filenames:

- `DECENTRALIZED MEDICINE #42...` -> `processed_mds/blog_series/DM/DM#42.md`
- `CPC #75...` -> `processed_mds/blog_series/CPC/CPC#75.md`
- `BTC #1...` -> `processed_mds/blog_series/BTC/BTC#1.md`
- `QT #28...` -> `processed_mds/blog_series/QT/QT#28.md`
- `HYPOXIA #30...` -> `processed_mds/blog_series/HYPOXIA/HYPOXIA#30.md`

Posts without a recognizable series/number are kept under `OTHER/` with a
sanitized title filename.
