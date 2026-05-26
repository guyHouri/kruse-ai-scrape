import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('static site archive exposes theme controls, forms, and latest report', () => {
  execFileSync(process.execPath, ['main.js', '--build-only', '--date=2026-05-26'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  execFileSync(process.execPath, ['code/build-site.js'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const indexHtml = readFileSync(path.join(ROOT, 'site', 'index.html'), 'utf8');
  const reportHtml = readFileSync(path.join(ROOT, 'site', 'reports', '2026-05-26.html'), 'utf8');
  const unsubscribeHtml = readFileSync(path.join(ROOT, 'site', 'unsubscribe', 'index.html'), 'utf8');

  assert.match(indexHtml, /data-theme-toggle/);
  assert.match(indexHtml, /body\.light/);
  assert.match(indexHtml, /reports\/2026-05-26\.html/);
  assert.match(indexHtml, /data-supabase-form="mailing-list"/);
  assert.match(indexHtml, /href="unsubscribe\/"/);

  assert.match(reportHtml, /site-menu-button/);
  assert.match(reportHtml, /id="get-report"/);
  assert.match(reportHtml, /id="report-feedback"/);
  assert.match(reportHtml, /data-supabase-form="mailing-list"/);
  assert.match(reportHtml, /data-supabase-form="feedback"/);
  assert.match(reportHtml, /--site-bg/);
  assert.match(reportHtml, /No selected signal/);
  assert.match(reportHtml, /href="\.\.\/unsubscribe\/"/);
  assert.doesNotMatch(reportHtml, /Forum Updates \(\d+ new/);

  assert.match(unsubscribeHtml, /data-supabase-form="unsubscribe"/);
  assert.match(unsubscribeHtml, /Unsubscribe/);
});
