// linkedin_to_md — tunables
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CREDS_TXT = path.join(__dirname, 'credentials.txt');

// Source of truth for which articles to scrape. Updated by discover stage
// (which logs in to scrape the recent-activity page) and merged with the
// xlsx archive.
export const ARTICLES_XLSX = 'Jack Kruse - All blogs up to 13th April 2026.xlsx';
export const XLSX_SHEET = 'LinkedIn (2016-2024)';
export const TARGET_PROFILE = 'drjackkruse';
export const ARTICLES_LIST_URL = `https://www.linkedin.com/in/${TARGET_PROFILE}/recent-activity/articles/`;

// Credentials for Playwright login (DISCOVER stage only — extract uses
// unauthenticated fetches). Loaded from credentials.txt (gitignored) or env.
function loadCreds() {
  const out = { user: process.env.LINKEDIN_USER || '', pass: process.env.LINKEDIN_PASS || '' };
  if ((!out.user || !out.pass) && existsSync(CREDS_TXT)) {
    const raw = readFileSync(CREDS_TXT, 'utf-8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
      if (!m) continue;
      if (m[1] === 'LINKEDIN_USER' && !out.user) out.user = m[2];
      if (m[1] === 'LINKEDIN_PASS' && !out.pass) out.pass = m[2];
    }
  }
  return out;
}
export const LINKEDIN_CREDS = loadCreds();

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Networking
export const REQUEST_DELAY_MS = 1200;        // polite — LinkedIn flags fast unauth fetches
export const REQUEST_TIMEOUT_MS = 30000;
export const CONCURRENCY = 2;                // small — single source, polite
export const RETRY_COUNT = 2;

// Extraction
export const MIN_BODY_CHARS = 200;           // drop article stubs

// Output
export const ARTICLE_SEPARATOR = '═'.repeat(70);
