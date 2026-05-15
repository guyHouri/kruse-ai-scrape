import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import {
  KEMONO_BASE_URL,
  SERVICE,
  USER_ID,
  CREATOR_NAME,
  OUTPUT_SLUG,
  MIN_TEXT_BODY_CHARS,
  ARTICLE_SEPARATOR,
} from '../settings.js';

const MEDIA_EXT_RE = /\.(?:jpg|jpeg|png|gif|webp|svg|ico|bmp|tif|tiff|mp4|webm|mov|mkv|avi|mp3|wav|ogg|m4a|zip|rar|7z|pdf)(?:[?#].*)?$/i;

function makeTurndown() {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
  });
  td.use(gfm);
  td.addRule('stripImages', {
    filter: ['img', 'picture', 'video', 'audio', 'source', 'iframe', 'svg'],
    replacement: () => '',
  });
  td.addRule('mediaLinksAsText', {
    filter: (node) => {
      if (node.nodeName !== 'A') return false;
      const href = node.getAttribute('href') || '';
      return isMediaUrl(href);
    },
    replacement: (content) => content || '',
  });
  return td;
}

const turndown = makeTurndown();

export function profileApiUrl() {
  return `${KEMONO_BASE_URL}/api/v1/${SERVICE}/user/${USER_ID}/profile`;
}

export function listApiUrl(offset) {
  return `${KEMONO_BASE_URL}/api/v1/${SERVICE}/user/${USER_ID}/posts?o=${offset}`;
}

export function detailApiUrl(postId) {
  return `${KEMONO_BASE_URL}/api/v1/${SERVICE}/user/${USER_ID}/post/${postId}`;
}

export function publicPostUrl(postId) {
  return `${KEMONO_BASE_URL}/${SERVICE}/user/${USER_ID}/post/${postId}`;
}

export function publicCreatorUrl() {
  return `${KEMONO_BASE_URL}/${SERVICE}/user/${USER_ID}/`;
}

export function normalizeListPost(post, discoveredAt) {
  const id = String(post.id || '').trim();
  if (!id) return null;
  return {
    id,
    service: SERVICE,
    user_id: USER_ID,
    creator: CREATOR_NAME,
    url: publicPostUrl(id),
    title: normalizeTitle(post.title, id),
    published_at: post.published || null,
    added_at: post.added || null,
    sources: ['kemono-api'],
    discovered_at: discoveredAt,
    extracted: false,
  };
}

export function normalizeDetail(detail) {
  const post = detail?.post || detail;
  if (!post || typeof post !== 'object') return null;
  const id = String(post.id || '').trim();
  if (!id) return null;
  return {
    id,
    title: normalizeTitle(post.title, id),
    published_at: post.published || null,
    edited_at: post.edited || null,
    added_at: post.added || null,
    contentHtml: typeof post.content === 'string' ? post.content : '',
  };
}

export function articleFilenameStem(article) {
  const date = (article.published_at || article.added_at || 'unknown').slice(0, 10) || 'unknown';
  return `${date}-${article.id}`;
}

export function renderArticleFile({ queueEntry, detail, scrapedAt }) {
  const title = detail.title || queueEntry.title || `Post ${queueEntry.id}`;
  const body = htmlToCleanMarkdown(detail.contentHtml);
  const effectiveBody = body && body.length >= MIN_TEXT_BODY_CHARS
    ? body
    : '_No textual article body was available in the API response._';

  return [
    '---',
    `slug: kemono-${SERVICE}-${OUTPUT_SLUG}-${queueEntry.id}`,
    'site: kemono.cr',
    `service: ${SERVICE}`,
    `creator: ${yamlString(CREATOR_NAME)}`,
    `user_id: ${USER_ID}`,
    `post_id: ${queueEntry.id}`,
    `published_at: ${detail.published_at || queueEntry.published_at || ''}`,
    `scraped_at: ${scrapedAt}`,
    'media_policy: text-only; attachments, previews, videos, and media links stripped',
    '---',
    '',
    ARTICLE_SEPARATOR,
    `# Article: ${title}`,
    `**Source:** <${publicPostUrl(queueEntry.id)}>`,
    `**Published:** ${detail.published_at || queueEntry.published_at || 'unknown'}`,
    ARTICLE_SEPARATOR,
    '',
    effectiveBody,
    '',
  ].join('\n');
}

export function renderBundleHeader({ year, scrapedAt, articleCount }) {
  return [
    '---',
    `slug: kemono-${SERVICE}-${OUTPUT_SLUG}`,
    'site: kemono.cr',
    `service: ${SERVICE}`,
    `creator: ${yamlString(CREATOR_NAME)}`,
    `user_id: ${USER_ID}`,
    `slice: ${year}`,
    `scraped_at: ${scrapedAt}`,
    `total_articles: ${articleCount}`,
    'media_policy: text-only; attachments, previews, videos, and media links stripped',
    '---',
    '',
    `# ${CREATOR_NAME} Patreon mirror - ${year}`,
    '',
    `**Source:** <${publicCreatorUrl()}>`,
    '',
    'Text-only article archive for NotebookLM. Each article preserves its original source URL; media and attachment surfaces are intentionally excluded.',
    '',
  ].join('\n');
}

export function yearBucket(entry) {
  const date = entry.published_at || entry.added_at || '';
  const year = date.slice(0, 4);
  return /^\d{4}$/.test(year) ? year : 'unknown';
}

function htmlToCleanMarkdown(html) {
  const normalized = normalizeLineTerminators(html || '');
  const $ = cheerio.load(`<main>${normalized}</main>`);
  $('script, style, noscript, form, button, img, picture, video, audio, source, iframe, svg').remove();
  $('a[href]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href') || '';
    if (isMediaUrl(href)) {
      $el.replaceWith($el.text());
    }
  });
  let body = turndown.turndown($.html($('main'))).trim();
  body = sanitizeMarkdown(body);
  return body;
}

function normalizeTitle(title, id) {
  const text = String(title || '').replace(/\s+/g, ' ').trim();
  return text || `Post ${id}`;
}

function normalizeLineTerminators(text) {
  return String(text).replace(/[\u2028\u2029\u0085\u000b\u000c]/g, '\n');
}

function sanitizeMarkdown(md) {
  return normalizeLineTerminators(md)
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/\[[^\]]*]\((?:[^)]*\/data\/[^)]*|[^)]*\/thumbnail\/[^)]*|[^)]*\.(?:jpg|jpeg|png|gif|webp|svg|mp4|webm|mov|mkv|avi|mp3|wav|ogg|m4a|zip|rar|7z|pdf)(?:[?#][^)]*)?)\)/gi, '')
    .replace(/https?:\/\/\S*(?:\/data\/|\/thumbnail\/)\S*/gi, '')
    .replace(/https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp|svg|mp4|webm|mov|mkv|avi|mp3|wav|ogg|m4a|zip|rar|7z|pdf)(?:[?#]\S*)?/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isMediaUrl(href) {
  if (!href) return false;
  try {
    const u = new URL(href, KEMONO_BASE_URL);
    return u.pathname.includes('/data/')
      || u.pathname.includes('/thumbnail/')
      || MEDIA_EXT_RE.test(u.pathname);
  } catch {
    return href.includes('/data/') || href.includes('/thumbnail/') || MEDIA_EXT_RE.test(href);
  }
}

function yamlString(value) {
  return JSON.stringify(String(value));
}
