import { existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function hasFlag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

function resolveReportDir(value) {
  const dir = value || 'out';
  return path.isAbsolute(dir) ? dir : path.join(ROOT, dir);
}

function reportFiles() {
  const explicitFile = argValue('file');
  if (explicitFile) {
    const file = path.isAbsolute(explicitFile) ? explicitFile : path.join(ROOT, explicitFile);
    return [file];
  }

  const dir = resolveReportDir(argValue('dir'));
  const date = argValue('date');
  if (date) return [path.join(dir, `${date}.html`)];

  if (!hasFlag('all')) throw new Error('pass --date=YYYY-MM-DD, --file=path, or --all');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.html$/.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}

async function closeAll(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.expanded-content.open').forEach((panel) => {
      panel.classList.remove('open');
      panel.setAttribute('aria-hidden', 'true');
    });
    document.querySelectorAll('.expandable-concept[aria-expanded="true"]').forEach((chip) => {
      chip.setAttribute('aria-expanded', 'false');
    });
  });
}

async function applyLevel(page, level) {
  const button = page.locator(`.level-toggle button[data-level="${level}"]`);
  if (await button.count()) {
    await button.click();
    return;
  }
  await page.evaluate((nextLevel) => {
    document.body.classList.remove('level-noob', 'level-pro', 'level-hacker');
    document.body.classList.add(`level-${nextLevel}`);
  }, level);
}

async function verifyStaticContract(page) {
  return page.evaluate(() => {
    const errors = [];
    const plainConceptTerms = new Set(['blue light', 'blue blockers']);
    const normalize = (term) => String(term || '')
      .toLowerCase()
      .replace(/[^a-z0-9+ ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const idCounts = new Map();
    document.querySelectorAll('[id]').forEach((node) => {
      const id = node.getAttribute('id');
      idCounts.set(id, (idCounts.get(id) || 0) + 1);
    });
    for (const [id, count] of idCounts.entries()) {
      if (count > 1) errors.push(`duplicate id "${id}" appears ${count} times`);
    }

    const chips = Array.from(document.querySelectorAll('.expandable-concept'));
    const panels = Array.from(document.querySelectorAll('.expanded-content'));
    const targetCounts = new Map();

    chips.forEach((chip, index) => {
      const label = chip.textContent.trim() || `chip ${index + 1}`;
      if (plainConceptTerms.has(normalize(label))) {
        errors.push(`${label}: known baseline term should render as plain text, not a concept chip`);
      }
      if (chip.hasAttribute('onclick')) errors.push(`${label}: inline onclick should not be used`);
      const target = chip.getAttribute('data-concept-target');
      if (!target) errors.push(`${label}: missing data-concept-target`);
      if (chip.getAttribute('aria-controls') !== target) errors.push(`${label}: aria-controls does not match target`);
      if (chip.getAttribute('aria-expanded') !== 'false') errors.push(`${label}: aria-expanded must start false`);
      if (!chip.getAttribute('data-card-id')) errors.push(`${label}: missing data-card-id`);
      if (!chip.getAttribute('data-concept-level')) errors.push(`${label}: missing data-concept-level`);
      if (chip.getAttribute('role') !== 'button') errors.push(`${label}: missing role=button`);
      if (chip.getAttribute('tabindex') == null) errors.push(`${label}: missing tabindex`);
      if (target) targetCounts.set(target, (targetCounts.get(target) || 0) + 1);

      const panel = target ? document.getElementById(target) : null;
      if (!panel) {
        errors.push(`${label}: target "${target}" does not exist`);
        return;
      }
      if (!panel.classList.contains('expanded-content')) errors.push(`${label}: target is not an expanded-content panel`);
      if (panel.getAttribute('aria-hidden') !== 'true') errors.push(`${label}: panel aria-hidden must start true`);
      if (panel.getAttribute('data-card-id') !== chip.getAttribute('data-card-id')) {
        errors.push(`${label}: chip/panel data-card-id mismatch`);
      }
      if (chip.closest('.card') !== panel.closest('.card')) {
        errors.push(`${label}: chip and panel are not inside the same card`);
      }
    });

    for (const [target, count] of targetCounts.entries()) {
      if (count > 1) errors.push(`concept target "${target}" is used by ${count} chips`);
    }

    panels.forEach((panel) => {
      if (!chips.some((chip) => chip.getAttribute('data-concept-target') === panel.id)) {
        errors.push(`panel "${panel.id}" has no matching chip`);
      }
    });

    return { errors, chipCount: chips.length, panelCount: panels.length };
  });
}

async function verifyNoobClicks(page) {
  const errors = [];
  await applyLevel(page, 'noob');
  const chips = await page.evaluate(() => Array.from(document.querySelectorAll('.expandable-concept')).map((chip, index) => ({
    index,
    text: chip.textContent.trim(),
    target: chip.getAttribute('data-concept-target'),
  })));

  for (const chipInfo of chips) {
    await closeAll(page);
    const chip = page.locator('.expandable-concept').nth(chipInfo.index);
    await chip.scrollIntoViewIfNeeded();
    await chip.click();

    const opened = await page.evaluate(({ index, target }) => {
      const errors = [];
      const chip = document.querySelectorAll('.expandable-concept')[index];
      const panel = document.getElementById(target);
      const openPanels = Array.from(document.querySelectorAll('.expanded-content.open'));
      if (!panel?.classList.contains('open')) errors.push('target panel did not open');
      if (openPanels.length !== 1 || openPanels[0] !== panel) errors.push(`expected only target panel open, found ${openPanels.length}`);
      if (chip?.getAttribute('aria-expanded') !== 'true') errors.push('chip aria-expanded did not become true');
      if (panel?.getAttribute('aria-hidden') !== 'false') errors.push('panel aria-hidden did not become false');
      return errors;
    }, chipInfo);
    errors.push(...opened.map((message) => `${chipInfo.text || chipInfo.target}: ${message}`));

    await chip.click();
    const closed = await page.evaluate(({ index, target }) => {
      const errors = [];
      const chip = document.querySelectorAll('.expandable-concept')[index];
      const panel = document.getElementById(target);
      const openPanels = Array.from(document.querySelectorAll('.expanded-content.open'));
      if (panel?.classList.contains('open')) errors.push('target panel did not close on second click');
      if (openPanels.length !== 0) errors.push(`expected all panels closed, found ${openPanels.length}`);
      if (chip?.getAttribute('aria-expanded') !== 'false') errors.push('chip aria-expanded did not return to false');
      if (panel?.getAttribute('aria-hidden') !== 'true') errors.push('panel aria-hidden did not return to true');
      return errors;
    }, chipInfo);
    errors.push(...closed.map((message) => `${chipInfo.text || chipInfo.target}: ${message}`));
  }

  return errors;
}

async function verifyReaderLevels(page) {
  const errors = [];

  await closeAll(page);
  await applyLevel(page, 'pro');
  errors.push(...await page.evaluate(() => {
    const errors = [];
    const chips = Array.from(document.querySelectorAll('.expandable-concept'));
    chips.forEach((chip) => {
      const isNoob = chip.getAttribute('data-concept-level') === 'noob';
      const disabled = chip.getAttribute('aria-disabled') === 'true';
      if (isNoob && !disabled) errors.push(`${chip.textContent.trim()}: noob chip should be disabled in pro mode`);
      if (!isNoob && disabled) errors.push(`${chip.textContent.trim()}: pro chip should remain enabled in pro mode`);
    });
    chips.filter((chip) => chip.getAttribute('data-concept-level') === 'noob').forEach((chip) => chip.click());
    if (document.querySelectorAll('.expanded-content.open').length) errors.push('noob chips opened while pro mode disabled them');
    return errors;
  }));

  await closeAll(page);
  await applyLevel(page, 'hacker');
  errors.push(...await page.evaluate(() => {
    const errors = [];
    const chips = Array.from(document.querySelectorAll('.expandable-concept'));
    chips.forEach((chip) => {
      if (chip.getAttribute('aria-disabled') !== 'true') errors.push(`${chip.textContent.trim()}: chip should be disabled in hacker mode`);
      chip.click();
    });
    if (document.querySelectorAll('.expanded-content.open').length) errors.push('concept chips opened while hacker mode disabled them');
    return errors;
  }));

  return errors;
}

async function verifyFile(browser, file) {
  if (!existsSync(file)) throw new Error(`report file does not exist: ${file}`);

  const pageErrors = [];
  const page = await browser.newPage();
  page.on('pageerror', (err) => pageErrors.push(`page error: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(`console error: ${msg.text()}`);
  });

  await page.goto(pathToFileURL(file).href, { waitUntil: 'domcontentloaded' });
  const staticResult = await verifyStaticContract(page);
  const clickErrors = staticResult.errors.length ? [] : await verifyNoobClicks(page);
  const levelErrors = staticResult.errors.length ? [] : await verifyReaderLevels(page);
  await page.close();

  return {
    file,
    chipCount: staticResult.chipCount,
    panelCount: staticResult.panelCount,
    errors: [...pageErrors, ...staticResult.errors, ...clickErrors, ...levelErrors],
  };
}

async function main() {
  const files = reportFiles();
  if (!files.length) throw new Error('no report files matched');

  const browser = await chromium.launch();
  const results = [];
  try {
    for (const file of files) results.push(await verifyFile(browser, file));
  } finally {
    await browser.close();
  }

  const failed = results.filter((result) => result.errors.length);
  for (const result of results) {
    const rel = path.relative(ROOT, result.file);
    console.log(`${failed.includes(result) ? 'FAIL' : 'PASS'} ${rel} (${result.chipCount} chips, ${result.panelCount} panels)`);
    for (const err of result.errors) console.log(`  - ${err}`);
  }

  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
