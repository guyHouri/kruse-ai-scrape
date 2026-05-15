// ============================================================
// settings.js — all tunables in one place
// Edit values here to tune the pipeline without touching logic.
//
// The site list lives in `websites.json` (array of objects with `slug`,
// `seedUrl`, `maxDepth`). Crawler and extractor load it themselves.
// ============================================================

// --- Networking ---
// Two UA constants so a stage discriminator can be re-introduced later (e.g.
// `…Chrome/124.0.0.0 Safari/537.36 FoodForAi-crawler`) — keep them separate
// even when identical. Currently both impersonate Chrome because some
// Israeli travel portals (lametayel.co.il) return a stub HTML to non-browser
// UAs, which made the crawler harvest 1 link instead of hundreds.
export const CRAWLER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
export const EXTRACTOR_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Polite delay between fetches in the crawl loop.
export const REQUEST_DELAY_MS = 500;

// Per-request timeout, shared across crawler and extractor. If you ever want
// per-stage timeouts, split into CRAWLER_/EXTRACTOR_ variants — both modules
// already import this name, so the migration is one-line-each.
export const REQUEST_TIMEOUT_MS = 15000;

// Parallel fetches in the extractor (bounded by p-limit).
export const CONCURRENCY = 4;

// --- Boilerplate stripping ---
// Tags removed at the document level before content-root selection, regardless
// of class/id. These are essentially never article content.
export const GLOBAL_BOILERPLATE_TAGS =
  'nav, header, footer, aside, script, style, noscript, iframe, form, svg';

// Class tokens that mark inline boilerplate (sidebars, share widgets, comment
// blocks, etc.). Matched at TOKEN level (whitespace-split), NOT substring —
// so `elementor-widget-xxx` is not killed by `widget`. An earlier substring-
// matching iteration blew the article body away on Elementor sites; if you
// extend this set, add specific tokens, don't generalize.
export const CLASS_TOKEN_BLOCKLIST = new Set([
  'sidebar', 'menu', 'submenu', 'mainmenu',
  'comments', 'comment', 'comment-list', 'comments-area',
  'related', 'related-posts', 'related-articles',
  'share', 'sharing', 'share-buttons', 'social', 'social-share', 'socials',
  'cookie', 'cookie-notice', 'cookie-banner',
  'newsletter', 'subscribe', 'subscription',
  'breadcrumb', 'breadcrumbs',
  'popup', 'modal',
  'author-box', 'author-bio', 'post-author',
  'post-nav', 'post-navigation', 'nav-links', 'pagination',
  'skip-link',
]);

// Element ids treated as boilerplate when they match exactly.
export const ID_BLOCKLIST = new Set([
  'sidebar', 'comments', 'respond', 'secondary', 'colophon', 'masthead',
]);

// --- Content extraction ---
// First selector with >200 chars of text wins; falls back to <body>. Order
// matters: more-specific (article inside main) before less-specific.
export const CONTENT_SELECTORS = [
  'article',
  'main article',
  '[role="main"] article',
  '.entry-content',
  '.post-content',
  '.single-post-content',
  '.article-content',
  'main',
  '[role="main"]',
  '.content-area',
  '#content',
  '.content',
];

// Pages whose extracted markdown is shorter than this are dropped as "empty"
// (typically index/tag/archive pages or paywalled stubs).
export const MIN_MARKDOWN_CHARS = 200;
