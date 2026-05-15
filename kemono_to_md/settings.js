// ============================================================
// settings.js - all tunables for kemono_to_md
// ============================================================

export const KEMONO_BASE_URL = 'https://kemono.cr';
export const SERVICE = 'patreon';
export const USER_ID = '6940816';
export const CREATOR_NAME = 'Dr. Jack Kruse';
export const OUTPUT_SLUG = 'drjackkruse';

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Kemono currently rejects JSON-ish Accept headers for scraping clients and
// explicitly asks for text/css. The response body is still JSON.
export const API_ACCEPT = 'text/css';

export const REQUEST_DELAY_MS = 1200;
export const REQUEST_TIMEOUT_MS = 20000;
export const CONCURRENCY = 2;
export const RETRY_COUNT = 3;
export const LIST_PAGE_SIZE = 50;

// Keep file-only/media-only posts visible as source stubs, but skip tiny
// remnants produced by stripping media widgets from otherwise empty HTML.
export const MIN_TEXT_BODY_CHARS = 20;
export const ARTICLE_SEPARATOR = '-'.repeat(70);
