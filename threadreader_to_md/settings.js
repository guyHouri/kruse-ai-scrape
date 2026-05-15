// ============================================================
// settings.js - all tunables for threadreader_to_md
// ============================================================

export const THREADREADER_BASE_URL = 'https://threadreaderapp.com';
export const SCREEN_NAME = 'DrJackKruse';
export const OUTPUT_SLUG = 'drjackkruse';

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export const REQUEST_DELAY_MS = 900;
export const REQUEST_TIMEOUT_MS = 20000;
export const CONCURRENCY = 3;
export const RETRY_COUNT = 3;
export const MAX_DISCOVERY_PAGES = 1000;

// NotebookLM source limits are 200MB and 500,000 words. Keep margin.
export const MAX_BUNDLE_BYTES = 190 * 1024 * 1024;
export const MAX_BUNDLE_WORDS = 490000;

export const THREAD_SEPARATOR = '-'.repeat(70);
