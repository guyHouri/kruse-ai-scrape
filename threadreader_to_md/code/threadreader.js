import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import {
  THREADREADER_BASE_URL,
  SCREEN_NAME,
  OUTPUT_SLUG,
  THREAD_SEPARATOR,
} from '../settings.js';

const MEDIA_URL_RE = /(?:pbs\.twimg\.com|video\.twimg\.com|\/images\/|\/media\/|\/thumbnail\/)|\.(?:jpg|jpeg|png|gif|webp|svg|mp4|webm|mov|mkv|avi)(?:[?#].*)?$/i;

function makeTurndown() {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
  });
  td.use(gfm);
  td.addRule('stripMedia', {
    filter: ['img', 'picture', 'video', 'audio', 'source', 'iframe', 'svg'],
    replacement: () => '',
  });
  td.addRule('stripMediaLinks', {
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

export function userPageUrl() {
  return `${THREADREADER_BASE_URL}/user/${SCREEN_NAME}`;
}

export function userAjaxUrl(beforeTs = null) {
  const base = `${THREADREADER_BASE_URL}/user/${SCREEN_NAME}?ajax=true`;
  return beforeTs ? `${base}&before=${beforeTs}` : base;
}

export function publicThreadUrl(id) {
  return `${THREADREADER_BASE_URL}/thread/${id}.html`;
}

export function parseUserPage(html, discoveredAt) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('.thread-card').each((_, card) => {
    const $card = $(card);
    const wrapper = $card.closest('[data-link-href]');
    const href = wrapper.attr('data-link-href') || $card.find('a[href*="/thread/"]').first().attr('href') || '';
    const id = threadIdFromHref(href);
    if (!id || seen.has(id)) return;
    seen.add(id);

    const timeEl = $card.find('span.time').first();
    const publishedTs = Number(timeEl.attr('data-time')) || null;
    const publishedLabel = timeEl.text().replace(/\s+/g, ' ').trim() || null;
    const infoText = $card.find('.thread-info').first().text().replace(/\s+/g, ' ').trim();
    const countMatch = infoText.match(/(\d+)\s+tweets?/i);
    const readMatch = infoText.match(/(\d+)\s+min read/i);
    const preview = cleanText($card.find('.card-tweetsv2').first().text());
    const title = titleFromPreview(preview, id);

    out.push({
      id,
      url: publicThreadUrl(id),
      title,
      preview,
      published_ts: publishedTs,
      published_label: publishedLabel,
      tweet_count_hint: countMatch ? Number(countMatch[1]) : null,
      min_read_hint: readMatch ? Number(readMatch[1]) : null,
      discovered_at: discoveredAt,
      extracted: false,
    });
  });

  const times = out.map((t) => t.published_ts).filter(Number.isFinite);
  const lastBefore = times.length ? Math.min(...times) : null;
  return { threads: out, lastBefore };
}

export function parseThreadPage(html, thread) {
  const $ = cheerio.load(html);
  const metaTitle = nonGenericTitle(thread.title)
    || titleFromPreview(thread.preview || '', thread.id)
    || $('meta[name="description"]').attr('content')
    || $('meta[property="og:description"]').attr('content')
    || $('meta[property="og:title"]').attr('content')
    || $('title').first().text()
    || `Thread ${thread.id}`;
  const title = cleanTitle(metaTitle, thread.id);
  const published = $('span.time').first().attr('data-time') || thread.published_ts || null;
  const tweets = [];

  $('.content-tweet').each((_, el) => {
    const $tweet = $(el);
    const tweetId = String($tweet.attr('data-tweet') || '').trim();
    if (!tweetId) return;
    const screenName = String($tweet.attr('data-screenname') || SCREEN_NAME).trim() || SCREEN_NAME;
    const orderMatch = String($tweet.attr('id') || '').match(/tweet_(\d+)/);
    const order = orderMatch ? Number(orderMatch[1]) : tweets.length + 1;

    $tweet.find('.nop, .tw-permalink, script, style, noscript, img, picture, video, audio, source, iframe, svg').remove();
    $tweet.find('.entity-image, .twitter-player').remove();
    $tweet.find('a[href]').each((_, a) => {
      const $a = $(a);
      const href = $a.attr('href') || '';
      if (isMediaUrl(href)) $a.replaceWith($a.text());
    });
    let bodyMd = turndown.turndown($.html($tweet)).trim();
    bodyMd = sanitizeMarkdown(bodyMd);
    if (!bodyMd) return;

    tweets.push({
      order,
      tweetId,
      screenName,
      url: `https://twitter.com/${screenName}/status/${tweetId}`,
      bodyMd,
    });
  });

  tweets.sort((a, b) => a.order - b.order);
  return { title, publishedTs: published ? Number(published) : null, tweets };
}

export function renderThreadFile({ thread, parsed, scrapedAt }) {
  const title = parsed.title || thread.title || `Thread ${thread.id}`;
  const publishedIso = parsed.publishedTs ? new Date(parsed.publishedTs * 1000).toISOString() : '';
  const body = parsed.tweets.map(renderTweet).join('\n');
  return [
    '---',
    `slug: threadreader-${OUTPUT_SLUG}-${thread.id}`,
    'site: threadreaderapp.com',
    `screen_name: ${SCREEN_NAME}`,
    `thread_id: ${thread.id}`,
    `published_at: ${publishedIso}`,
    `scraped_at: ${scrapedAt}`,
    'media_policy: text-only; images, embedded players, and media URLs stripped',
    '---',
    '',
    THREAD_SEPARATOR,
    `# Thread: ${title}`,
    `**Source:** <${publicThreadUrl(thread.id)}>`,
    publishedIso ? `**Published:** ${publishedIso}` : '**Published:** unknown',
    `**Tweets:** ${parsed.tweets.length}`,
    THREAD_SEPARATOR,
    '',
    body,
    '',
  ].join('\n');
}

function renderTweet(tweet) {
  return [
    `### Tweet ${tweet.order}`,
    `**Source:** <${tweet.url}>`,
    '',
    tweet.bodyMd,
    '',
  ].join('\n');
}

function threadIdFromHref(href) {
  const m = String(href || '').match(/\/thread\/(\d+)\.html/);
  return m ? m[1] : null;
}

function titleFromPreview(preview, id) {
  const noNumber = preview.replace(/^\s*\d+\.\s*/, '').trim();
  const sentence = noNumber.split(/\n|(?<=\.)\s+/)[0] || noNumber;
  const title = sentence.length > 120 ? sentence.slice(0, 120).trim() : sentence;
  return title || `Thread ${id}`;
}

function nonGenericTitle(title) {
  const clean = String(title || '').trim();
  if (!clean) return null;
  if (/^Thread by @DrJackKruse on Thread Reader App$/i.test(clean)) return null;
  return clean;
}

function cleanTitle(raw, id) {
  return String(raw || '')
    .replace(/^@DrJackKruse:\s*/i, '')
    .replace(/^\s*\d+\.\s*/, '')
    .replace(/\s+-\s+Thread from Dr. Jack Kruse @DrJackKruse.*$/i, '')
    .replace(/\s+@\w+\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim() || `Thread ${id}`;
}

function cleanText(text) {
  return normalizeLineTerminators(text)
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

function sanitizeMarkdown(md) {
  return normalizeLineTerminators(md)
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/\[[^\]]*]\((?:[^)]*pbs\.twimg\.com[^)]*|[^)]*video\.twimg\.com[^)]*|[^)]*\.(?:jpg|jpeg|png|gif|webp|svg|mp4|webm|mov|mkv|avi)(?:[?#][^)]*)?)\)/gi, '')
    .replace(/https?:\/\/\S*(?:pbs\.twimg\.com|video\.twimg\.com)\S*/gi, '')
    .replace(/\b(?:pbs|video)\.twimg\.com\/\S*/gi, '')
    .replace(/https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp|svg|mp4|webm|mov|mkv|avi)(?:[?#]\S*)?/gi, '')
    .replace(/^\s*\d+\\?\.\s*/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeLineTerminators(text) {
  return String(text || '').replace(/[\u2028\u2029\u0085\u000b\u000c]/g, '\n');
}

function isMediaUrl(href) {
  if (!href) return false;
  try {
    const u = new URL(href, THREADREADER_BASE_URL);
    return MEDIA_URL_RE.test(u.href) || MEDIA_URL_RE.test(u.pathname);
  } catch {
    return MEDIA_URL_RE.test(href);
  }
}
