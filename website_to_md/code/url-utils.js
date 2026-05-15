const SKIP_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico', '.bmp', '.tif', '.tiff',
  '.pdf', '.zip', '.rar', '.7z', '.tar', '.gz',
  '.mp3', '.mp4', '.wav', '.ogg', '.m4a', '.avi', '.mov', '.mkv', '.webm',
  '.css', '.js', '.xml', '.rss', '.json',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
]);

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
  return abs.toString();
}

export function sameRegistrableHost(a, b) {
  const ha = new URL(a).hostname.replace(/^www\./, '');
  const hb = new URL(b).hostname.replace(/^www\./, '');
  return ha === hb;
}

export function hasSkippedExtension(urlStr) {
  try {
    const pathname = new URL(urlStr).pathname.toLowerCase();
    const dot = pathname.lastIndexOf('.');
    if (dot === -1) return false;
    const ext = pathname.slice(dot);
    return SKIP_EXTENSIONS.has(ext);
  } catch {
    return false;
  }
}

export function slugFromHost(hostname) {
  return hostname.replace(/^www\./, '').split('.')[0];
}

export function slugFromUrl(urlStr) {
  const u = new URL(urlStr);
  let path = decodeURIComponent(u.pathname);
  if (path === '/' || path === '') path = '/home';
  let slug = path
    .replace(/^\/+|\/+$/g, '')
    .replace(/\//g, '_')
    .replace(/[\\:*?"<>|]/g, '-')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_');
  if (slug.length > 110) slug = slug.slice(0, 110);
  if (!slug) slug = 'page';
  if (u.search) {
    slug += '-' + Math.abs(hash32(u.search)).toString(16).slice(0, 6);
  }
  return slug;
}

function hash32(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}
