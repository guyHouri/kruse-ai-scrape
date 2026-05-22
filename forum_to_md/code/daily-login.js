// XenForo username/password login.
// Exchanges credentials for a session cookie string usable in subsequent fetches.
//
// Flow:
//   1. GET /login → parse the page's _xfToken
//   2. POST /login/login with username + password + _xfToken
//   3. Capture Set-Cookie headers (xf_user, xf_session, xf_csrf)
//   4. Return them concatenated as a single Cookie header value
//
// Designed for the daily cron — cookies it returns live for the duration of
// one daily run, then are discarded. No on-disk cookie persistence.

import * as cheerio from 'cheerio';
import { FORUM_BASE_URL, USER_AGENT, REQUEST_TIMEOUT_MS } from '../settings.js';
import { info, warn } from './logger.js';

const FORUM_USERNAME = process.env.FORUM_USERNAME || '';
const FORUM_PASSWORD = process.env.FORUM_PASSWORD || '';

function timeoutFetch(url, init) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  return fetch(url, { ...init, signal: ctl.signal }).finally(() => clearTimeout(t));
}

function mergeSetCookie(cookieJar, setCookieHeaders) {
  // node fetch concatenates multiple Set-Cookie headers with ", " — split on
  // ", " followed by a cookie-name=. Take name=value pair, ignore attributes.
  for (const raw of setCookieHeaders) {
    for (const part of raw.split(/,\s*(?=[^=,;\s]+=)/)) {
      const m = part.match(/^\s*([^=;]+)=([^;]*)/);
      if (m) cookieJar.set(m[1].trim(), m[2].trim());
    }
  }
}

function cookieHeader(cookieJar) {
  return [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

// Returns { cookieString, jar } on success; throws on failure.
export async function loginToForum({ username = FORUM_USERNAME, password = FORUM_PASSWORD } = {}) {
  if (!username || !password) {
    throw new Error('FORUM_USERNAME / FORUM_PASSWORD not set');
  }
  const jar = new Map();

  // Step 1: GET /login to retrieve _xfToken and seed cookies.
  info(`forum-login: GET ${FORUM_BASE_URL}/login`);
  const loginPage = await timeoutFetch(`${FORUM_BASE_URL}/login`, {
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    redirect: 'follow',
  });
  if (!loginPage.ok) throw new Error(`forum-login: GET /login HTTP ${loginPage.status}`);
  mergeSetCookie(jar, loginPage.headers.getSetCookie ? loginPage.headers.getSetCookie() : []);
  const html = await loginPage.text();
  const $ = cheerio.load(html);
  const xfToken = $('input[name="_xfToken"]').first().attr('value') || '';
  if (!xfToken) warn('forum-login: no _xfToken found on /login (proceeding anyway)');

  // Step 2: POST /login/login with credentials.
  const body = new URLSearchParams({
    login: username,
    password,
    remember: '1',
    register: '0',
    _xfToken: xfToken,
    _xfRedirect: FORUM_BASE_URL + '/',
  });

  info(`forum-login: POST ${FORUM_BASE_URL}/login/login as ${username}`);
  const res = await timeoutFetch(`${FORUM_BASE_URL}/login/login`, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html,application/xhtml+xml',
      Cookie: cookieHeader(jar),
      Referer: `${FORUM_BASE_URL}/login`,
      Origin: FORUM_BASE_URL,
    },
    body: body.toString(),
    redirect: 'manual', // we want to capture Set-Cookie before redirect
  });
  mergeSetCookie(jar, res.headers.getSetCookie ? res.headers.getSetCookie() : []);

  // Success path: 303/302 with new session cookie. Verify by looking for xf_user.
  if (!jar.has('xf_user') && !jar.has('xf_session')) {
    const bodyText = await res.text();
    const errBlock = cheerio.load(bodyText)('.blockMessage--error').first().text().trim();
    throw new Error(`forum-login: failed (status=${res.status}) ${errBlock || 'no session cookie returned'}`);
  }

  const cookieString = cookieHeader(jar);
  info(`forum-login: ok — cookies acquired (${jar.size} entries)`);
  return { cookieString, jar };
}
