import path from 'node:path';

const SERIES_ALIASES = [
  {
    series: 'DM',
    folderHints: ['decentralized-medicine'],
    patterns: [
      /DECENTRALI[ZS]ED\s+MEDICINE\s*#?\s*(\d+)/i,
      /DECENTALIZED\s+MEDICINE\s*#?\s*(\d+)/i,
      /DECENTRALIZE\s+MEDICINE\s*#?\s*(\d+)/i,
      /DECENTRALIZING\b/i,
    ],
  },
  { series: 'CPC', folderHints: ['cpc'], patterns: [/\bCPC\s*#?\s*(\d+)/i] },
  { series: 'QT', folderHints: [], patterns: [/\bQT\s*#?\s*(\d+)/i] },
  { series: 'HYPOXIA', folderHints: [], patterns: [/\bHYPOXIA\s*#?\s*(\d+)/i] },
  { series: 'BTC', folderHints: ['bitcoin', 'btc'], patterns: [/\bBTC\b/i, /\bBITCOIN\b/i] },
];

export function classifyBlogSeries(title, sourcePath = '') {
  const cleanTitle = cleanDisplayTitle(title);
  const haystack = `${cleanTitle} ${sourcePath}`.replace(/[_-]+/g, ' ');
  const lowerPath = sourcePath.toLowerCase();

  for (const alias of SERIES_ALIASES) {
    const hinted = alias.folderHints.some((hint) => lowerPath.includes(hint));
    for (const pattern of alias.patterns) {
      const m = haystack.match(pattern);
      if (m || hinted) {
        const number = extractNumber(cleanTitle, m);
        return buildClassification(alias.series, number, cleanTitle);
      }
    }
  }

  const generic = cleanTitle.match(/^([A-Z][A-Z0-9]{1,15})\s*#\s*(\d+)/);
  if (generic) {
    return buildClassification(generic[1], Number(generic[2]), cleanTitle);
  }

  return {
    series: 'OTHER',
    number: null,
    filenameBase: safeFilePart(cleanTitle) || 'untitled',
    displayTitle: cleanTitle,
  };
}

export function cleanDisplayTitle(raw) {
  return String(raw || 'Untitled')
    .replace(/\.pdf$/i, '')
    .replace(/\s+-\s+Optimal Klubs$/i, '')
    .replace(/_/g, ':')
    .replace(/\s+/g, ' ')
    .replace(/\s+:/g, ':')
    .trim();
}

export function safeFilePart(raw, maxLen = 120) {
  let s = cleanDisplayTitle(raw)
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\s*#\s*/g, '#')
    .replace(/[- ]{2,}/g, ' ')
    .trim();
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  return s.replace(/[. ]+$/g, '') || 'untitled';
}

export function sortBlogFiles(a, b) {
  const sa = a.series.localeCompare(b.series);
  if (sa !== 0) return sa;
  const na = a.number ?? Number.MAX_SAFE_INTEGER;
  const nb = b.number ?? Number.MAX_SAFE_INTEGER;
  if (na !== nb) return na - nb;
  return a.name.localeCompare(b.name);
}

function buildClassification(series, number, title) {
  return {
    series,
    number,
    filenameBase: number ? `${series}#${number}` : `${series}-${safeFilePart(title, 100)}`,
    displayTitle: title,
  };
}

function extractNumber(title, match) {
  if (match?.[1] && Number.isFinite(Number(match[1]))) return Number(match[1]);
  const anyHash = title.match(/#\s*(\d+)/);
  if (anyHash) return Number(anyHash[1]);
  return null;
}

export function relativePosix(from, to) {
  return path.relative(from, to).replace(/\\/g, '/');
}
