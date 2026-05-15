// URL helpers specific to a XenForo forum. Slim version of website_to_md's
// url-utils — we don't need cross-domain crawling or skipped-extension
// filtering because the discover stage only follows known XenForo URL
// patterns and the extract stage only fetches thread URLs from threads.json.

export function normalizeUrl(href, baseUrl) {
  let abs;
  try {
    abs = new URL(href, baseUrl);
  } catch {
    return null;
  }
  if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null;
  abs.hash = '';
  abs.hostname = abs.hostname.toLowerCase();
  // Force https for forum.jackkruse.com — http redirects to https anyway, and
  // dedupe across `http://...` and `https://...` variants of the same URL
  if (abs.hostname === 'forum.jackkruse.com' && abs.protocol === 'http:') {
    abs.protocol = 'https:';
  }
  return abs.toString();
}

// XenForo thread URL: /threads/<slug>.<numericId>/ optionally followed by
// /page-N or /post-NNN or other suffixes. Captures the trailing numeric id.
const THREAD_URL_RE = /\/threads\/[^/]+?\.(\d+)\/?/;

export function isThreadUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    return THREAD_URL_RE.test(u.pathname);
  } catch {
    return false;
  }
}

export function threadIdFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const m = u.pathname.match(THREAD_URL_RE);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

// Strip /page-N or /post-NNN suffix from a thread URL to get its canonical
// page-1 URL. Used to dedupe references to the same thread.
export function canonicalThreadUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const m = u.pathname.match(/^(.*\/threads\/[^/]+?\.\d+\/)(?:page-\d+|post-\d+).*$/);
    if (m) {
      u.pathname = m[1];
      u.search = '';
      u.hash = '';
      return u.toString();
    }
    // Already canonical — just strip search/hash
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return urlStr;
  }
}

// XenForo subforum URL: /forums/<slug>.<numericId>/
const SUBFORUM_URL_RE = /\/forums\/[^/]+?\.(\d+)\/?$/;

export function isSubforumUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    return SUBFORUM_URL_RE.test(u.pathname);
  } catch {
    return false;
  }
}

// Convert a thread URL into a filename-safe stem: <slug>.<id> matching
// XenForo's own URL convention. Used as the per-thread .md filename so a
// human browsing processed_mds/threads/ can scan titles at a glance.
// Sanitizes Windows-unsafe chars and truncates very long slugs.
export function threadFilenameStem(urlStr) {
  try {
    const u = new URL(urlStr);
    const m = u.pathname.match(/\/threads\/([^/]+)\.(\d+)\/?/);
    if (!m) return null;
    let slug = decodeURIComponent(m[1]);
    // Strip Windows-unsafe chars (\\ / : * ? " < > |) and control chars
    slug = slug.replace(/[\\/:*?"<>|\x00-\x1f]/g, '-');
    // Collapse runs of dashes/underscores/dots that may result
    slug = slug.replace(/[-_]{2,}/g, '-');
    if (slug.length > 100) slug = slug.slice(0, 100);
    if (!slug) slug = 'thread';
    return `${slug}.${m[2]}`;
  } catch {
    return null;
  }
}
