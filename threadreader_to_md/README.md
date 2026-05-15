# threadreader_to_md

Crawler for all Thread Reader App unrolled threads by `@DrJackKruse`.

Input:

- `https://threadreaderapp.com/user/DrJackKruse`

Outputs:

- `threads.json` - resumable thread queue.
- `processed_mds/threads/<thread-id>.md` - one markdown file per unrolled thread.
- `processed_mds/tweet-threads.md` or `tweet-threads-N.md` - NotebookLM upload files.

## Commands

- `npm start` - full pipeline.
- `npm run discover` - discover thread cards from the user page.
- `npm run extract` - download pending thread pages.
- `npm run bundle` - rebuild NotebookLM bundles.
- `node main.js --extract-only --limit=3` - smoke-test a few pending threads.

## NotebookLM Limits

The bundler splits with conservative limits:

- under 190MB per file
- under 490,000 words per file

This stays below NotebookLM's documented 200MB and 500,000-word source limits.

## Text-Only Policy

The extractor keeps tweet text and ordinary links, but strips images, embedded
players, Twitter media URLs, and Thread Reader lazy image placeholders. It does
not download media assets.
