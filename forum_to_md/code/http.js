// Shared HTTP fetch wrapper for both discover and extract stages. Injects the
// XenForo session cookie, enforces per-request timeout via AbortController,
// retries transient failures (network errors, 5xx), and surfaces structured
// error info so a FAIL line in the log carries context (status, ctype, message).

import {
  XENFORO_COOKIE,
  USER_AGENT,
  REQUEST_TIMEOUT_MS,
  RETRY_COUNT,
} from '../settings.js';
import { debug, warn } from './logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns { html, status, sizeKB, errMessage }. html is null on any failure.
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
          'Cookie': XENFORO_COOKIE,
        },
        redirect: 'follow',
      });
      clearTimeout(t);
      const ctype = res.headers.get('content-type') || '';
      if (!res.ok) {
        // 4xx is non-retryable; 5xx is retryable
        const errMessage = `HTTP ${res.status}`;
        if (res.status >= 500 && attempt < retries) {
          warn(`fetch ${res.status} ${url} — retrying (${attempt + 1}/${retries})`);
          await sleep(1000 * (attempt + 1));
          continue;
        }
        return { html: null, status: res.status, sizeKB: 0, errMessage };
      }
      if (!ctype.includes('text/html') && !ctype.includes('application/xhtml')) {
        return { html: null, status: res.status, sizeKB: 0, errMessage: `non-html ctype=${ctype}` };
      }
      const html = await res.text();
      const sizeKB = Number((Buffer.byteLength(html, 'utf-8') / 1024).toFixed(1));
      // XenForo serves an HTTP-200 login page when xf_session is expired;
      // detect that as a sentinel so callers can prompt for cookie refresh.
      const loginRedirect = /data-template="login"/.test(html) && /data-logged-in="false"/.test(html);
      debug(`GET ${res.status} ${sizeKB}KB ${url}${loginRedirect ? ' [LOGIN-REDIRECT]' : ''}`);
      return { html, status: res.status, sizeKB, errMessage: null, loginRedirect };
    } catch (err) {
      clearTimeout(t);
      lastErr = err;
      if (attempt < retries) {
        warn(`fetch error ${url} — retrying (${attempt + 1}/${retries}): ${err.message}`);
        await sleep(1000 * (attempt + 1));
        continue;
      }
    }
  }
  return {
    html: null,
    status: 0,
    sizeKB: 0,
    errMessage: lastErr ? `${lastErr.code || 'ERR'}: ${lastErr.message}` : 'unknown error',
  };
}
