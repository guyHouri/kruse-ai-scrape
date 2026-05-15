# threadreader_to_md

Text-only crawler for Thread Reader App unrolled tweet threads from:

`https://threadreaderapp.com/user/DrJackKruse`

This project-part is intentionally separate from `forum_to_md/` and
`kemono_to_md/`.

## Run

- `npm start` - discover threads, extract pending thread pages, then write NotebookLM bundles.
- `npm run discover` - walk Thread Reader's infinite-scroll user page into `threads.json`.
- `npm run extract` - fetch each `/thread/<id>.html` page and write one per-thread markdown file.
- `npm run bundle` - rebuild `tweet-threads.md` / `tweet-threads-N.md` from per-thread files.
- `node main.js --extract-only --limit=N` - smoke-test extraction on N pending threads.

## Storage

- `threads.json` is the resumable queue.
- `processed_mds/threads/<thread-id>.md` is one text-only unrolled thread file.
- `processed_mds/tweet-threads.md` or `processed_mds/tweet-threads-N.md` are final NotebookLM upload bundles.

The bundler targets under 190MB and under 490,000 words per file, below
NotebookLM's 200MB / 500,000-word source limits.

## Safety / Content Policy

This crawler is text-only:

- Do not use browser automation or screenshots.
- Do not download images, videos, or embedded player assets.
- Strip Twitter image/video URLs and Thread Reader lazy image placeholders from markdown.
- Keep ordinary external links because they are part of the tweet text.
- Every thread has a `**Source:**` line for the Thread Reader URL.
- Every tweet has a `**Source:**` line for its Twitter/X status URL.

## Discovery Notes

Thread Reader's user page loads the first batch through:

`/user/DrJackKruse?ajax=true`

Further batches use the last visible card's timestamp:

`/user/DrJackKruse?ajax=true&before=<last-data-time>`

Each card links to `/thread/<id>.html`; each extracted thread page exposes
tweets in `.content-tweet` blocks with `data-tweet`.
