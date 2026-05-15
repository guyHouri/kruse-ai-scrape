import {
  USER_AGENT,
  REQUEST_TIMEOUT_MS,
  RETRY_COUNT,
} from '../settings.js';
import { warn, debug } from './logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function retryDelayMs(res, attempt) {
  const retryAfter = res?.headers?.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  }
  return 1000 * (attempt + 1);
}

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

      const ctype = res.headers.get('content-type') || '';
      if (!res.ok) {
        const errMessage = `HTTP ${res.status}`;
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          const delay = retryDelayMs(res, attempt);
          warn(`fetch ${res.status} ${url} - retrying in ${delay}ms (${attempt + 1}/${retries})`);
          await sleep(delay);
          continue;
        }
        return { html: null, status: res.status, sizeKB: 0, errMessage };
      }
      if (!ctype.includes('text/html') && !ctype.includes('application/xhtml')) {
        return { html: null, status: res.status, sizeKB: 0, errMessage: `non-html ctype=${ctype}` };
      }
      const html = await res.text();
      const sizeKB = Number((Buffer.byteLength(html, 'utf-8') / 1024).toFixed(1));
      debug(`GET ${res.status} ${sizeKB}KB ${url}`);
      return { html, status: res.status, sizeKB, errMessage: null };
    } catch (err) {
      clearTimeout(t);
      lastErr = err;
      if (attempt < retries) {
        const delay = 1000 * (attempt + 1);
        warn(`fetch error ${url} - retrying in ${delay}ms (${attempt + 1}/${retries}): ${err.message}`);
        await sleep(delay);
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
