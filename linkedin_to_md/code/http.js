// Polite unauthenticated fetch wrapper for LinkedIn Pulse article bodies.
// LinkedIn Pulse articles are SEO-public — accessible without auth — but rate-
// limit aggressive clients. Use long delays + low concurrency.
import { USER_AGENT, REQUEST_TIMEOUT_MS, RETRY_COUNT } from '../settings.js';
import { debug, warn } from './logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchHtml(url, { retries = RETRY_COUNT } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        redirect: 'follow',
      });
      clearTimeout(t);
      if (res.status === 429 || res.status === 999) {
        warn(`fetch ${res.status} ${url} — rate-limited`);
        if (attempt < retries) {
          await sleep(5000 * (attempt + 1));
          continue;
        }
        return { html: null, status: res.status, errMessage: `HTTP ${res.status} (rate-limited)` };
      }
      if (!res.ok) {
        if (res.status >= 500 && attempt < retries) {
          await sleep(2000 * (attempt + 1));
          continue;
        }
        return { html: null, status: res.status, errMessage: `HTTP ${res.status}` };
      }
      const ctype = res.headers.get('content-type') || '';
      if (!ctype.includes('text/html') && !ctype.includes('application/xhtml')) {
        return { html: null, status: res.status, errMessage: `non-html ctype=${ctype}` };
      }
      const html = await res.text();
      const sizeKB = Number((Buffer.byteLength(html, 'utf-8') / 1024).toFixed(1));
      // Authwall detection — Pulse articles normally render server-side, but
      // sometimes LinkedIn shows an auth wall. Detect via small body or login title.
      const isAuthWall = html.length < 5000 && /(authwall|sign[- ]in|join now)/i.test(html);
      if (isAuthWall) {
        return { html: null, status: res.status, errMessage: 'authwall' };
      }
      debug(`GET ${res.status} ${sizeKB}KB ${url.slice(0, 100)}`);
      return { html, status: res.status, sizeKB, errMessage: null };
    } catch (err) {
      clearTimeout(t);
      lastErr = err;
      if (attempt < retries) { await sleep(2000 * (attempt + 1)); continue; }
    }
  }
  return { html: null, status: 0, errMessage: lastErr ? `${lastErr.code || 'ERR'}: ${lastErr.message}` : 'unknown' };
}
