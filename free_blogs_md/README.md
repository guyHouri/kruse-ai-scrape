# free_blogs_md

Convert `jk_free_blogs_combinedd (2).pdf` (Jack Kruse's compiled free-blog corpus, 2444 pages) into NotebookLM-ready markdown bundles + per-blog source-of-truth MDs.

## Output

```
processed_mds/
├── blogs/<slug>.md            253 per-blog markdown files (source of truth)
├── free-blogs#1.md            bundle 1 (≤ 195 MB, ≤ 490k words)
├── free-blogs#2.md            bundle 2
├── free-blogs#3.md            bundle 3
└── free-blogs-index.xlsx      slug / title / word_count / bundle_file / url
```

Totals: **253 blogs, 1,436,423 words, 3 bundles** (~2.8 MB each).

## How it works

The PDF was assembled by concatenating individual blog post print-views. Each post starts with the canonical URL `https://www.jackkruse.com/<slug>/` followed by `Page X of Y` and a date stamp. `extract.py`:

1. Walks every page with `pypdf`, records the first jackkruse.com URL seen on each page.
2. Pages without a URL inherit the most recent URL — that's how multi-page blogs stay grouped.
3. Strips `Page X of Y …` headers, `01/15/2017, 10:23 …` timestamps, and duplicate URL lines.
4. Concatenates the cleaned pages per slug → writes `processed_mds/blogs/<slug>.md`.
5. Packs blogs into bundle files capped at 490k words / 195 MB.
6. Writes `free-blogs-index.xlsx`.

## Run

```sh
pip install pypdf openpyxl
python extract.py
```

Single pass, ~30 s. Re-running overwrites all outputs.

## Why a PDF and not the live site

The PDF is a one-shot historical snapshot someone made of every public Jack Kruse blog post up through 2017. The live jackkruse.com blog is still up, but most posts are now behind the paid `/products/` paywall. The PDF is the practical archive for free content; this module just normalises it.

For new posts since 2017 / paid posts → see `FUTURE_IMPROVEMENTS.md`.

## Source

`jk_free_blogs_combinedd (2).pdf` (33 MB, 2444 pages) — provenance: shared by the project originators. Not committed to git (`.gitignore` excludes it). Drop a fresh copy at the repo path before running.
