"""
free_blogs_md/extract.py
Convert jk_free_blogs_combinedd (2).pdf -> per-blog markdown + linkedin-style bundles.

Detects blog boundary by 'https://www.jackkruse.com/<slug>/' header on each page.
Strips per-page chrome ('Page X of Y', date stamps).
Writes:
  processed_mds/blogs/<slug>.md       per-blog source-of-truth
  processed_mds/free-blogs#N.md       bundles, capped 490k words / 195MB
  processed_mds/free-blogs-index.xlsx index
"""
from __future__ import annotations
import pypdf
import re
import sys
import json
import os
import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PDF = ROOT / 'jk_free_blogs_combinedd (2).pdf'
OUT = ROOT / 'processed_mds'
BLOGS = OUT / 'blogs'
MAX_WORDS = 490_000
MAX_BYTES = 195 * 1024 * 1024

URL_RE = re.compile(r'https?://(?:www\.)?jackkruse\.com/([a-z0-9][a-z0-9-/]*?)/?\s*$', re.I | re.M)
PAGE_HDR_RE = re.compile(r'^\s*Page\s+\d+\s+of\s+\d+\s+[A-Za-z]{3}\s+\d{1,2},\s+\d{4}.*$', re.M)
ALT_FOOTER_RE = re.compile(r'^\s*\d+\s+of\s+\d+\s+\d{2}/\d{2}/\d{4}.*$', re.M)
TRAIL_DATE_RE = re.compile(r'^\s*\d{2}/\d{2}/\d{4},?\s+\d{1,2}:\d{2}.*$', re.M)


def detect_blog_url(text: str) -> str | None:
    """First jackkruse.com URL on the page = blog identifier."""
    m = URL_RE.search(text)
    if not m:
        return None
    return m.group(1).strip('/').lower()


def clean_page(text: str) -> str:
    text = PAGE_HDR_RE.sub('', text)
    text = ALT_FOOTER_RE.sub('', text)
    text = TRAIL_DATE_RE.sub('', text)
    # strip the leading URL line itself
    text = URL_RE.sub('', text, count=1)
    # collapse 3+ blank lines
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


def slug_to_title(slug: str) -> str:
    return ' '.join(w.capitalize() for w in slug.split('-'))


def main():
    if not PDF.exists():
        print(f'ERR: pdf not found at {PDF}', file=sys.stderr)
        sys.exit(1)
    OUT.mkdir(exist_ok=True)
    BLOGS.mkdir(exist_ok=True)

    print(f'reading {PDF.name}...')
    r = pypdf.PdfReader(str(PDF))
    n = len(r.pages)
    print(f'  {n} pages')

    # Pass 1: collect (slug, cleaned_text) per page
    by_slug: dict[str, list[str]] = {}
    page_meta: list[tuple[int, str | None]] = []  # (page_no, slug)
    current_slug = None
    for i in range(n):
        try:
            raw = r.pages[i].extract_text() or ''
        except Exception as e:
            print(f'  WARN page {i+1}: {e}')
            raw = ''
        slug = detect_blog_url(raw)
        if slug:
            current_slug = slug
        cleaned = clean_page(raw)
        if current_slug and cleaned:
            by_slug.setdefault(current_slug, []).append(cleaned)
        page_meta.append((i + 1, current_slug))
        if (i + 1) % 200 == 0:
            print(f'  parsed {i+1}/{n}, blogs seen={len(by_slug)}')

    pre_pages = [pm for pm in page_meta if pm[1] is None]
    print(f'  preamble (no url): {len(pre_pages)} pages')
    print(f'  blogs detected: {len(by_slug)}')

    # Pass 2: write per-blog MDs
    blogs = []
    for slug, parts in by_slug.items():
        body = '\n\n'.join(parts)
        # strip duplicate title lines that often appear after url
        body = re.sub(r'\n{3,}', '\n\n', body).strip()
        wc = len(body.split())
        url = f'https://www.jackkruse.com/{slug}/'
        title = slug_to_title(slug)
        md = (
            f'---\n'
            f'# Blog: {title}\n'
            f'**Source:** <{url}>\n'
            f'**Slug:** {slug}\n'
            f'**Word Count:** {wc}\n'
            f'---\n\n'
            f'{body}\n'
        )
        outp = BLOGS / f'{slug.replace("/", "_")[:120]}.md'
        outp.write_text(md, encoding='utf-8')
        blogs.append({'slug': slug, 'title': title, 'url': url, 'word_count': wc, 'file': outp.name})

    # sort by slug for stable order
    blogs.sort(key=lambda b: b['slug'])
    print(f'  wrote {len(blogs)} per-blog MDs to {BLOGS.relative_to(ROOT)}')

    # Pass 3: pack into bundles
    # clean prior bundles
    for f in OUT.glob('free-blogs#*.md'):
        f.unlink()

    parts: list[list[dict]] = []
    cur: list[dict] = []
    cur_w = 0
    cur_b = 0
    for b in blogs:
        md_path = BLOGS / b['file']
        body = md_path.read_text(encoding='utf-8')
        item_b = len(body.encode('utf-8')) + 2
        if (cur_w + b['word_count'] > MAX_WORDS or cur_b + item_b > MAX_BYTES) and cur:
            parts.append(cur)
            cur, cur_w, cur_b = [], 0, 0
        cur.append({'b': b, 'body': body, 'bytes': item_b})
        cur_w += b['word_count']
        cur_b += item_b
    if cur:
        parts.append(cur)

    scraped_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    slug_to_bundle: dict[str, str] = {}
    for i, part in enumerate(parts):
        name = f'free-blogs#{i+1}.md'
        outp = OUT / name
        words = sum(it['b']['word_count'] for it in part)
        yaml = (
            f'---\n'
            f'slug: jackkruse-free-blogs\n'
            f'site: jackkruse.com\n'
            f'part: {i+1}\n'
            f'total_parts: {len(parts)}\n'
            f'scraped_at: {scraped_at}\n'
            f'total_blogs_in_part: {len(part)}\n'
            f'total_words_in_part: {words}\n'
            f'---\n\n'
            f'# Dr. Jack Kruse — Free Blogs, part {i+1} of {len(parts)}\n\n'
            f'**Source:** <https://www.jackkruse.com/blog/>\n\n'
            f'Compiled from `jk_free_blogs_combinedd (2).pdf`. Part {i+1} of {len(parts)}.\n\n'
        )
        with outp.open('w', encoding='utf-8') as fh:
            fh.write(yaml)
            for it in part:
                fh.write(it['body'])
                fh.write('\n')
                slug_to_bundle[it['b']['slug']] = name
        size_mb = outp.stat().st_size / 1024 / 1024
        print(f'  {name}: {len(part)} blogs, {words:,} words, {size_mb:.2f} MB')

    # xlsx index
    try:
        from openpyxl import Workbook
        wb = Workbook()
        ws = wb.active
        ws.title = 'Blogs'
        ws.append(['slug', 'title', 'word_count', 'bundle_file', 'article_file', 'url'])
        for b in blogs:
            ws.append([b['slug'], b['title'], b['word_count'], slug_to_bundle.get(b['slug'], ''), b['file'], b['url']])
        xlsx = OUT / 'free-blogs-index.xlsx'
        wb.save(xlsx)
        print(f'  -> Excel: {xlsx.relative_to(ROOT)} ({len(blogs)} rows)')
    except ImportError:
        print('  (skip xlsx: openpyxl not installed; pip install openpyxl)')

    print(f'-> {len(parts)} bundles, {len(blogs)} blogs, {sum(b["word_count"] for b in blogs):,} words')


if __name__ == '__main__':
    main()
