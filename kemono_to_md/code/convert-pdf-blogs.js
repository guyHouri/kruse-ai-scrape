import { readdir, readFile, writeFile, mkdir, rm, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  PROJECT_ROOT,
  BLOG_PDF_DIR,
  BLOG_SERIES_DIR,
} from './storage.js';
import {
  classifyBlogSeries,
  cleanDisplayTitle,
  relativePosix,
} from './series-utils.js';
import { info, warn, section } from './logger.js';

const execFileAsync = promisify(execFile);

export async function runConvertPdfBlogs() {
  section('Convert PDF blogs by series');
  if (!existsSync(BLOG_PDF_DIR)) {
    info(`No PDF blog folder found at ${BLOG_PDF_DIR}`);
    return;
  }

  const pdfs = await listPdfs(BLOG_PDF_DIR);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kemono-pdf-'));
  const used = new Set();
  let converted = 0;
  let failed = 0;

  try {
    for (const pdfPath of pdfs) {
      const title = cleanDisplayTitle(path.basename(pdfPath));
      const classification = classifyBlogSeries(title, pdfPath);
      const seriesDir = path.join(BLOG_SERIES_DIR, classification.series);
      await mkdir(seriesDir, { recursive: true });

      const txtPath = path.join(tmpDir, `${converted + failed}.txt`);
      try {
        await execFileAsync('pdftotext', ['-layout', '-enc', 'UTF-8', pdfPath, txtPath], { windowsHide: true });
        const text = sanitizePdfText(await readFile(txtPath, 'utf-8'));
        const md = renderPdfMarkdown({
          title,
          sourcePath: pdfPath,
          text,
        });
        const targetName = uniquePdfName({
          dir: seriesDir,
          base: classification.filenameBase,
          used,
        });
        await writeFile(path.join(seriesDir, targetName), md, 'utf-8');
        converted++;
      } catch (err) {
        failed++;
        warn(`PDF convert failed: ${relativePosix(PROJECT_ROOT, pdfPath)} - ${err.message}`);
      }
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  info(`-> converted ${converted} PDFs into blog_series (failed ${failed})`);
}

async function listPdfs(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await listPdfs(full));
    } else if (entry.isFile() && /\.pdf$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function renderPdfMarkdown({ title, sourcePath, text }) {
  return [
    '---',
    'site: local-pdf',
    `source_pdf: ${JSON.stringify(relativePosix(PROJECT_ROOT, sourcePath))}`,
    'media_policy: text-only PDF conversion',
    '---',
    '',
    `# ${title}`,
    `**Source PDF:** \`${relativePosix(PROJECT_ROOT, sourcePath)}\``,
    '',
    text || '_No extractable text was found in this PDF._',
    '',
  ].join('\n');
}

function sanitizePdfText(text) {
  return String(text || '')
    .replace(/[\u2028\u2029\u0085\u000b\u000c]/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function uniquePdfName({ dir, base, used }) {
  const candidates = [`${base}.md`, `${base}-pdf.md`];
  for (const name of candidates) {
    const key = path.join(dir, name).toLowerCase();
    if (!used.has(key) && !existsSync(path.join(dir, name))) {
      used.add(key);
      return name;
    }
  }

  let n = 2;
  while (true) {
    const name = `${base}-pdf-${n}.md`;
    const key = path.join(dir, name).toLowerCase();
    if (!used.has(key) && !existsSync(path.join(dir, name))) {
      used.add(key);
      return name;
    }
    n++;
  }
}
