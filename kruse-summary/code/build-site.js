// Build a small static archive website from generated daily report HTML files.
//
// Output:
//   site/index.html
//   site/thanks.html
//   site/reports/YYYY-MM-DD.html
//   site/_redirects
//   site/_headers
//
// Forms can post directly to Supabase with a publishable key and insert-only
// RLS policies. Google Forms remains as a fallback while migrating.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'out');
const CURATED_DIR = path.join(ROOT, 'curated');
const SITE_DIR = path.join(ROOT, 'site');
const SITE_REPORTS_DIR = path.join(SITE_DIR, 'reports');
const SITE_LATEST_DIR = path.join(SITE_DIR, 'latest');
const PUBLIC_BASE_URL = process.env.KRUSE_SITE_PUBLIC_BASE_URL || 'https://guyhouri.github.io/kruse-ai-scrape';
const DEFAULT_SUPABASE_URL = 'https://zpxhovwsswnjdjibcvsh.supabase.co';
const DEFAULT_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_afhmZKXzerLWNYENUqsaFg_XfVWjODD';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  DEFAULT_SUPABASE_PUBLISHABLE_KEY;
const SUPABASE_TABLES = {
  mailingList: process.env.SUPABASE_MAILING_LIST_TABLE || 'kruse_mailing_list',
  feedback: process.env.SUPABASE_FEEDBACK_TABLE || 'kruse_report_feedback',
};
const GOOGLE_FORM_PUBLIC_URL = process.env.KRUSE_GOOGLE_FORM_PUBLIC_URL || '';
const GOOGLE_FORM_ACTION = process.env.KRUSE_GOOGLE_FORM_ACTION || '';
const GOOGLE_FORM_ENTRIES = {
  type: process.env.KRUSE_GOOGLE_FORM_ENTRY_TYPE || '',
  name: process.env.KRUSE_GOOGLE_FORM_ENTRY_NAME || '',
  email: process.env.KRUSE_GOOGLE_FORM_ENTRY_EMAIL || '',
  frequency: process.env.KRUSE_GOOGLE_FORM_ENTRY_FREQUENCY || '',
  reportDate: process.env.KRUSE_GOOGLE_FORM_ENTRY_REPORT_DATE || '',
  reportUrl: process.env.KRUSE_GOOGLE_FORM_ENTRY_REPORT_URL || '',
  rating: process.env.KRUSE_GOOGLE_FORM_ENTRY_RATING || '',
  feedback: process.env.KRUSE_GOOGLE_FORM_ENTRY_FEEDBACK || '',
};

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(date) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

function publicUrl(relativePath) {
  return new URL(relativePath.replace(/^\/+/, ''), `${PUBLIC_BASE_URL.replace(/\/+$/, '')}/`).toString();
}

function isSupabaseReady() {
  return Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY);
}

function isGoogleSignupFormReady() {
  return Boolean(
    GOOGLE_FORM_ACTION &&
    GOOGLE_FORM_ENTRIES.type &&
    GOOGLE_FORM_ENTRIES.email &&
    GOOGLE_FORM_ENTRIES.frequency
  );
}

function isGoogleFeedbackFormReady() {
  return Boolean(
    GOOGLE_FORM_ACTION &&
    GOOGLE_FORM_ENTRIES.type &&
    GOOGLE_FORM_ENTRIES.email &&
    GOOGLE_FORM_ENTRIES.rating &&
    GOOGLE_FORM_ENTRIES.feedback
  );
}

function isSignupFormReady() {
  return isSupabaseReady() || isGoogleSignupFormReady();
}

function isFeedbackFormReady() {
  return isSupabaseReady() || isGoogleFeedbackFormReady();
}

function googleHidden(entry, value) {
  return entry ? `<input type="hidden" name="${esc(entry)}" value="${esc(value)}" />` : '';
}

function hiddenInput(field, value, googleEntry = '') {
  return isSupabaseReady()
    ? `<input type="hidden" name="${esc(field)}" value="${esc(value)}" />`
    : googleHidden(googleEntry, value);
}

function fieldName(field, googleEntry = '') {
  return isSupabaseReady() ? field : (googleEntry || field);
}

function formAttrs(kind, googleReady) {
  if (isSupabaseReady()) return `method="POST" data-supabase-form="${esc(kind)}"`;
  return googleReady
    ? `method="POST" action="${esc(GOOGLE_FORM_ACTION)}" target="google-form-target" data-google-form="true"`
    : 'onsubmit="return false" data-form-disabled="true"';
}

function disabledAttr(ready) {
  return ready ? '' : ' disabled';
}

function submitLabel(ready, label) {
  return ready ? label : 'Signup backend pending';
}

function submitControl(ready, label, fallbackLabel) {
  if (ready) return `<button type="submit">${esc(label)}</button>`;
  if (GOOGLE_FORM_PUBLIC_URL) {
    return `<a class="form-link" href="${esc(GOOGLE_FORM_PUBLIC_URL)}" target="_blank" rel="noopener">${esc(fallbackLabel)}</a>`;
  }
  return `<button type="submit" disabled>${esc(submitLabel(false, label))}</button>`;
}

function googleFormIframe() {
  return !isSupabaseReady() && GOOGLE_FORM_ACTION
    ? '<iframe name="google-form-target" title="Google Forms submission target" style="display:none"></iframe>'
    : '';
}

function googleFormScript() {
  return !isSupabaseReady() && GOOGLE_FORM_ACTION
    ? `<script>
    (function () {
      document.addEventListener('submit', function (event) {
        var form = event.target;
        if (!form || !form.hasAttribute('data-google-form')) return;
        var message = form.querySelector('[data-form-success]');
        window.setTimeout(function () {
          if (message) message.hidden = false;
          form.reset();
        }, 700);
      });
    })();
  </script>`
    : '';
}

function supabaseFormScript() {
  if (!isSupabaseReady()) return '';
  return `<script>
    window.__KRUSE_SUPABASE = ${JSON.stringify({
      url: SUPABASE_URL.replace(/\/+$/, ''),
      key: SUPABASE_PUBLISHABLE_KEY,
      tables: SUPABASE_TABLES,
    })};
    (function () {
      var config = window.__KRUSE_SUPABASE;
      if (!config || !config.url || !config.key) return;

      function value(form, name) {
        var field = form.querySelector('[name="' + name + '"]');
        return field ? String(field.value || '').trim() : '';
      }

      function nullable(value) {
        return value ? value : null;
      }

      function show(form, selector, text) {
        var node = form.querySelector(selector);
        if (!node) return;
        if (text) node.textContent = text;
        node.hidden = false;
      }

      function hide(form, selector) {
        var node = form.querySelector(selector);
        if (node) node.hidden = true;
      }

      function payloadFor(form, kind) {
        var common = {
          first_name: value(form, 'first_name'),
          last_name: value(form, 'last_name'),
          email: value(form, 'email').toLowerCase(),
          comments: value(form, 'comments'),
          report_date: nullable(value(form, 'report_date')),
          report_url: nullable(value(form, 'report_url')),
          page_url: window.location.href,
          source: 'public-site'
        };
        if (kind === 'mailing-list') {
          common.frequency = value(form, 'frequency') || 'Daily';
          return common;
        }
        return {
          first_name: common.first_name,
          last_name: common.last_name,
          email: nullable(common.email),
          rating: value(form, 'rating') || 'Useful',
          comments: common.comments,
          report_date: common.report_date,
          report_url: common.report_url,
          page_url: common.page_url,
          source: common.source
        };
      }

      async function submitToSupabase(form, kind) {
        var table = kind === 'feedback' ? config.tables.feedback : config.tables.mailingList;
        var payload = payloadFor(form, kind);
        var response = await fetch(config.url + '/rest/v1/' + encodeURIComponent(table), {
          method: 'POST',
          headers: {
            apikey: config.key,
            authorization: 'Bearer ' + config.key,
            'content-type': 'application/json',
            prefer: 'return=minimal'
          },
          body: JSON.stringify(payload)
        });
        if (!response.ok) {
          var text = await response.text();
          throw new Error(text || ('Supabase returned ' + response.status));
        }
      }

      document.addEventListener('submit', async function (event) {
        var form = event.target;
        if (!form || !form.hasAttribute('data-supabase-form')) return;
        event.preventDefault();

        hide(form, '[data-form-success]');
        hide(form, '[data-form-error]');

        var trap = form.querySelector('input[name="company"], input[name="website"]');
        if (trap && trap.value) {
          form.reset();
          show(form, '[data-form-success]');
          return;
        }

        var button = form.querySelector('button[type="submit"]');
        if (button) button.disabled = true;
        try {
          await submitToSupabase(form, form.getAttribute('data-supabase-form'));
          form.reset();
          show(form, '[data-form-success]');
        } catch (err) {
          console.error(err);
          show(form, '[data-form-error]', 'Could not save. Please try again.');
        } finally {
          if (button) button.disabled = false;
        }
      });
    })();
  </script>`;
}

function formStorageNote(kind, ready) {
  if (isSupabaseReady()) {
    return kind === 'feedback'
      ? 'Saved privately for prompt tuning.'
      : 'Saved privately to the mailing list.';
  }
  if (ready || GOOGLE_FORM_PUBLIC_URL) return 'Saved to Google Forms and synced automatically.';
  return 'Signup backend is not configured yet.';
}

function readSummary(date) {
  const file = path.join(CURATED_DIR, `${date}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function reportFiles() {
  if (!existsSync(OUT_DIR)) return [];
  return readdirSync(OUT_DIR)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.html$/.test(name))
    .sort()
    .map((name) => {
      const date = name.replace(/\.html$/, '');
      const summary = readSummary(date);
      return {
        date,
        name,
        href: `reports/${name}`,
        sourcePath: path.join(OUT_DIR, name),
        headline: summary?.headline_subtitle || 'Daily Kruse report',
      };
    });
}

function renderReportCards(reports) {
  return reports
    .slice()
    .reverse()
    .map((report, index) => `
      <a class="report-card${index === 0 ? ' latest' : ''}" href="${esc(report.href)}">
        <span class="report-date">${esc(formatDate(report.date))}</span>
        <strong>Kruse Report</strong>
        <span class="report-summary">${esc(report.headline)}</span>
        <span class="report-open">Open report</span>
      </a>`)
    .join('\n');
}

function themeToggleButton(className = 'theme-toggle') {
  return `<button type="button" class="${esc(className)}" data-theme-toggle>Light mode</button>`;
}

function themeScript() {
  return `<script>
    (function () {
      function savedTheme() {
        try { return localStorage.getItem('kruse-theme'); } catch (e) { return null; }
      }
      function storeTheme(theme) {
        try { localStorage.setItem('kruse-theme', theme); } catch (e) {}
      }
      function applyTheme(theme) {
        var light = theme === 'light';
        document.body.classList.toggle('light', light);
        var buttons = document.querySelectorAll('[data-theme-toggle]');
        for (var i = 0; i < buttons.length; i++) {
          buttons[i].textContent = light ? 'Dark mode' : 'Light mode';
          buttons[i].setAttribute('aria-pressed', light ? 'true' : 'false');
        }
      }
      var initial = savedTheme() || 'dark';
      applyTheme(initial);
      document.addEventListener('click', function (event) {
        var button = event.target.closest && event.target.closest('[data-theme-toggle]');
        if (!button) return;
        var next = document.body.classList.contains('light') ? 'dark' : 'light';
        storeTheme(next);
        applyTheme(next);
      });
    })();
  </script>`;
}

function renderIndex(reports) {
  const latest = reports[reports.length - 1];
  const latestHref = latest ? latest.href : '#';
  const latestDate = latest ? formatDate(latest.date) : 'No reports yet';
  const signupReady = isSignupFormReady();
  const cards = reports.length
    ? renderReportCards(reports)
    : '<div class="empty">No reports have been generated yet.</div>';
  const themeButton = themeToggleButton();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Kruse Daily Reports</title>
  <meta name="description" content="Daily archive of Kruse report summaries." />
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0f19;
      --panel: #121a2a;
      --panel-2: #172033;
      --border: #26334d;
      --text: #f4f7fb;
      --soft: #c6d2e1;
      --muted: #8fa0b5;
      --accent: #4ea1ff;
      --accent-2: #7bdcb5;
      --danger: #ffbd7a;
      --field: #0d1422;
      --button-text: #06101d;
      --page-glow-1: rgba(78,161,255,0.14);
      --page-glow-2: rgba(123,220,181,0.16);
    }
    body.light {
      color-scheme: light;
      --bg: #f7f9fc;
      --panel: #ffffff;
      --panel-2: #eef3f8;
      --border: #d8e0ea;
      --text: #111827;
      --soft: #334155;
      --muted: #64748b;
      --accent: #2563eb;
      --accent-2: #047857;
      --danger: #b45309;
      --field: #ffffff;
      --button-text: #ffffff;
      --page-glow-1: rgba(37,99,235,0.10);
      --page-glow-2: rgba(4,120,87,0.10);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(180deg, var(--page-glow-1), transparent 260px),
        radial-gradient(circle at top right, var(--page-glow-2), transparent 360px),
        var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    a { color: inherit; }
    .shell { width: min(1120px, calc(100% - 32px)); margin: 0 auto; padding: 32px 0 56px; }
    header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: end;
      gap: 24px;
      padding: 24px 0 28px;
      border-bottom: 1px solid var(--border);
    }
    .header-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
    h1 { margin: 0; font-size: clamp(2rem, 5vw, 4rem); line-height: 0.95; letter-spacing: 0; }
    .subtitle { margin: 14px 0 0; max-width: 720px; color: var(--soft); font-size: 1.02rem; line-height: 1.55; }
    .latest-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 44px;
      padding: 0 16px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--panel);
      color: var(--text);
      text-decoration: none;
      font-weight: 700;
      white-space: nowrap;
    }
    .theme-toggle {
      width: auto;
      margin: 0;
      min-height: 44px;
      padding: 0 14px;
      border: 1px solid var(--border);
      background: var(--panel);
      color: var(--text);
      white-space: nowrap;
    }
    main { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 28px; padding-top: 28px; align-items: start; }
    .section-label { color: var(--muted); text-transform: uppercase; font-size: 0.78rem; letter-spacing: 0.08em; margin-bottom: 12px; font-weight: 800; }
    .report-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 14px; }
    .report-card {
      min-height: 190px;
      display: grid;
      grid-template-rows: auto auto 1fr auto;
      gap: 10px;
      padding: 18px;
      background: linear-gradient(180deg, var(--panel), var(--panel-2));
      border: 1px solid var(--border);
      border-radius: 8px;
      text-decoration: none;
      transition: transform 0.16s ease, border-color 0.16s ease;
    }
    .report-card:hover { transform: translateY(-2px); border-color: var(--accent); }
    .report-card.latest { border-color: rgba(123,220,181,0.58); }
    .report-date { color: var(--accent-2); font-weight: 800; font-size: 0.9rem; }
    .report-card strong { font-size: 1.35rem; line-height: 1.1; }
    .report-summary { color: var(--soft); line-height: 1.45; }
    .report-open { color: var(--accent); font-size: 0.92rem; font-weight: 800; }
    .signup {
      position: sticky;
      top: 20px;
      padding: 18px;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    .signup h2 { margin: 0 0 8px; font-size: 1.35rem; }
    .signup p { margin: 0 0 16px; color: var(--soft); line-height: 1.45; }
    label { display: block; margin: 12px 0 6px; color: var(--muted); font-size: 0.82rem; font-weight: 800; }
    input, select, textarea {
      width: 100%;
      min-height: 42px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--field);
      color: var(--text);
      padding: 0 12px;
      font: inherit;
    }
    textarea { min-height: 96px; padding: 10px 12px; resize: vertical; }
    button {
      width: 100%;
      margin-top: 16px;
      min-height: 44px;
      border: 0;
      border-radius: 6px;
      background: var(--accent);
      color: var(--button-text);
      font-weight: 900;
      cursor: pointer;
    }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    .form-link {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      margin-top: 16px;
      min-height: 44px;
      border-radius: 6px;
      background: var(--accent);
      color: var(--button-text);
      font-weight: 900;
      text-decoration: none;
    }
    .form-success { margin-top: 12px; color: var(--accent-2); font-size: 0.88rem; font-weight: 800; }
    .form-error { margin-top: 12px; color: var(--danger); font-size: 0.88rem; font-weight: 800; }
    .fine-print { margin-top: 12px; color: var(--muted); font-size: 0.8rem; line-height: 1.4; }
    .empty {
      padding: 20px;
      border: 1px dashed var(--border);
      border-radius: 8px;
      color: var(--muted);
    }
    footer { margin-top: 44px; color: var(--muted); font-size: 0.85rem; }
    @media (max-width: 820px) {
      header { grid-template-columns: 1fr; align-items: start; }
      main { grid-template-columns: 1fr; }
      .signup { position: static; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div>
        <h1>Kruse Daily Reports</h1>
        <p class="subtitle">Daily source-bound summaries from Jack Kruse tweets and forum activity. Latest report: ${esc(latestDate)}.</p>
      </div>
      <div class="header-actions">
        ${themeButton}
        <a class="latest-link" href="${esc(latestHref)}">Open latest</a>
      </div>
    </header>
    <main>
      <section aria-labelledby="reports-title">
        <div class="section-label" id="reports-title">Report archive</div>
        <div class="report-grid">
${cards}
        </div>
      </section>
      <aside class="signup" aria-labelledby="signup-title">
        <h2 id="signup-title">Get the report</h2>
        <p>Leave an email and we will add you when daily delivery opens.</p>
        <form name="kruse-report-interest" ${formAttrs('mailing-list', isGoogleSignupFormReady())}>
          ${hiddenInput('form_type', 'kruse-report-interest', GOOGLE_FORM_ENTRIES.type)}
          ${hiddenInput('report_url', publicUrl('index.html'), GOOGLE_FORM_ENTRIES.reportUrl)}
          <p style="display:none"><label>Company <input name="company" /></label></p>
          <label for="first-name">First name</label>
          <input id="first-name" name="${esc(fieldName('first_name', GOOGLE_FORM_ENTRIES.name))}" autocomplete="given-name"${disabledAttr(signupReady)} />
          <label for="last-name">Last name</label>
          <input id="last-name" name="${esc(fieldName('last_name'))}" autocomplete="family-name"${disabledAttr(signupReady)} />
          <label for="email">Email</label>
          <input id="email" name="${esc(fieldName('email', GOOGLE_FORM_ENTRIES.email))}" type="email" autocomplete="email" required${disabledAttr(signupReady)} />
          <label for="frequency">Delivery</label>
          <select id="frequency" name="${esc(fieldName('frequency', GOOGLE_FORM_ENTRIES.frequency))}"${disabledAttr(signupReady)}>
            <option>Daily</option>
            <option>Only strong signal days</option>
            <option>Weekly digest</option>
          </select>
          <label for="comments">Comments</label>
          <textarea id="comments" name="${esc(fieldName('comments'))}"${disabledAttr(signupReady)}></textarea>
          ${submitControl(signupReady, 'Join list', 'Open signup form')}
          <div class="form-success" data-form-success hidden>Saved. You are on the list.</div>
          <div class="form-error" data-form-error hidden>Could not save. Please try again.</div>
        </form>
        <div class="fine-print">${formStorageNote('mailing-list', signupReady)}</div>
      </aside>
    </main>
    <footer>Built from ${reports.length} report${reports.length === 1 ? '' : 's'}.</footer>
    ${googleFormIframe()}
  </div>
  ${supabaseFormScript()}
  ${googleFormScript()}
  ${themeScript()}
</body>
</html>`;
}

function renderThanks() {
  const themeButton = themeToggleButton();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Thanks - Kruse Daily Reports</title>
  <style>
    :root { color-scheme: dark; --bg: #0b0f19; --panel: #121a2a; --border: #26334d; --text: #f4f7fb; --soft: #c6d2e1; --accent: #4ea1ff; }
    body.light { color-scheme: light; --bg: #f7f9fc; --panel: #ffffff; --border: #d8e0ea; --text: #111827; --soft: #334155; --accent: #2563eb; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    main { width: min(560px, calc(100% - 32px)); padding: 28px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
    h1 { margin: 0 0 10px; font-size: 2rem; letter-spacing: 0; }
    p { color: var(--soft); line-height: 1.55; }
    a { color: var(--accent); font-weight: 800; }
    .theme-toggle { position: fixed; top: 16px; right: 16px; min-height: 40px; padding: 0 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); font: inherit; font-weight: 800; cursor: pointer; }
  </style>
</head>
<body>
  ${themeButton}
  <main>
    <h1>You are on the list.</h1>
    <p>Thanks. Your request was saved.</p>
    <p><a href="/">Back to reports</a></p>
  </main>
  ${themeScript()}
</body>
</html>`;
}

function renderLatestRedirect(latest) {
  const target = latest ? `../reports/${latest.name}` : '../index.html';
  const themeButton = themeToggleButton();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Latest Kruse Report</title>
  <meta http-equiv="refresh" content="0; url=${esc(target)}" />
  <link rel="canonical" href="${esc(target)}" />
  <style>
    :root { color-scheme: dark; --bg: #0b0f19; --panel: #121a2a; --border: #26334d; --text: #f4f7fb; --soft: #c6d2e1; --accent: #4ea1ff; }
    body.light { color-scheme: light; --bg: #f7f9fc; --panel: #ffffff; --border: #d8e0ea; --text: #111827; --soft: #334155; --accent: #2563eb; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    main { padding: 20px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
    a { color: var(--accent); font-weight: 800; }
    .theme-toggle { position: fixed; top: 16px; right: 16px; min-height: 40px; padding: 0 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); font: inherit; font-weight: 800; cursor: pointer; }
  </style>
</head>
<body>
  ${themeButton}
  <main>
    <p>Opening the latest report. <a href="${esc(target)}">Open it manually</a>.</p>
  </main>
  ${themeScript()}
</body>
</html>`;
}

function reportSiteChrome(report) {
  const dateLabel = formatDate(report.date);
  const signupReady = isSignupFormReady();
  const feedbackReady = isFeedbackFormReady();
  return {
    style: `<style>
    html { scroll-behavior: smooth; }
    body {
      --site-bg: #0b0f19;
      --site-panel: #121a2a;
      --site-panel-2: #0d1422;
      --site-border: #26334d;
      --site-text: #f4f7fb;
      --site-soft: #c6d2e1;
      --site-muted: #8fa0b5;
      --site-accent: #4ea1ff;
      --site-success: #7bdcb5;
      --site-danger: #ffbd7a;
      --site-button-text: #06101d;
      padding: 32px 16px 48px !important;
      flex-direction: column !important;
      justify-content: flex-start !important;
      align-items: flex-start !important;
    }
    body.light {
      --site-bg: #f7f9fc;
      --site-panel: #ffffff;
      --site-panel-2: #f8fafc;
      --site-border: #d8e0ea;
      --site-text: #111827;
      --site-soft: #334155;
      --site-muted: #64748b;
      --site-accent: #2563eb;
      --site-success: #047857;
      --site-danger: #b45309;
      --site-button-text: #ffffff;
    }
    body.site-drawer-open { overflow: hidden; }
    .container {
      max-width: 690px !important;
      margin-left: auto !important;
      margin-right: auto !important;
    }
    .site-menu-button {
      position: fixed;
      top: 16px;
      left: 16px;
      z-index: 80;
      width: 44px;
      height: 44px;
      border: 1px solid var(--site-border);
      border-radius: 8px;
      background: var(--site-panel);
      color: var(--site-text);
      font-size: 1.45rem;
      line-height: 1;
      cursor: pointer;
      box-shadow: 0 12px 30px rgba(0,0,0,0.28);
    }
    .site-report-backdrop {
      position: fixed;
      inset: 0;
      z-index: 88;
      background: rgba(3,7,18,0.58);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.18s ease;
    }
    .site-report-drawer {
      position: fixed;
      inset: 0 auto 0 0;
      z-index: 90;
      width: min(320px, calc(100vw - 48px));
      padding: 18px;
      background: var(--site-bg);
      border-right: 1px solid var(--site-border);
      transform: translateX(-105%);
      transition: transform 0.2s ease;
      box-shadow: 24px 0 60px rgba(0,0,0,0.38);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body.site-drawer-open .site-report-backdrop {
      opacity: 1;
      pointer-events: auto;
    }
    body.site-drawer-open .site-report-drawer { transform: translateX(0); }
    .site-drawer-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      padding-bottom: 16px;
      margin-bottom: 12px;
      border-bottom: 1px solid var(--site-border);
    }
    .site-drawer-kicker {
      margin-bottom: 4px;
      color: var(--site-muted);
      font-size: 0.78rem;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .site-drawer-title { color: var(--site-text); font-size: 1rem; font-weight: 850; line-height: 1.25; }
    .site-drawer-close {
      width: 34px;
      height: 34px;
      flex: 0 0 auto;
      border: 1px solid var(--site-border);
      border-radius: 8px;
      background: var(--site-panel);
      color: var(--site-text);
      font-size: 1.3rem;
      line-height: 1;
      cursor: pointer;
    }
    .site-drawer-link {
      display: block;
      padding: 12px;
      margin-bottom: 8px;
      border: 1px solid var(--site-border);
      border-radius: 8px;
      background: var(--site-panel);
      color: var(--site-text);
      text-decoration: none;
    }
    .site-drawer-link strong { display: block; font-size: 0.95rem; }
    .site-drawer-link span { display: block; margin-top: 3px; color: var(--site-muted); font-size: 0.82rem; line-height: 1.35; }
    .site-report-footer {
      width: min(690px, calc(100% - 32px));
      margin: 34px auto 48px;
      display: grid;
      grid-template-columns: 1fr;
      gap: 16px;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .site-report-panel {
      padding: 18px;
      background: var(--site-panel);
      border: 1px solid var(--site-border);
      border-radius: 8px;
      color: var(--site-text);
    }
    .site-report-panel h2 {
      margin: 0 0 8px;
      color: var(--site-text);
      font-size: 1.2rem;
      letter-spacing: 0;
    }
    .site-report-panel p { margin: 0 0 14px; color: var(--site-soft); line-height: 1.45; }
    .site-report-panel label { display: block; margin: 10px 0 6px; color: var(--site-muted); font-size: 0.82rem; font-weight: 800; }
    .site-report-panel input,
    .site-report-panel textarea,
    .site-report-panel select {
      width: 100%;
      min-height: 40px;
      border: 1px solid var(--site-border);
      border-radius: 6px;
      background: var(--site-panel-2);
      color: var(--site-text);
      padding: 0 10px;
      font: inherit;
    }
    .site-report-panel textarea { min-height: 118px; padding: 10px; resize: vertical; }
    .site-report-panel button {
      width: 100%;
      margin-top: 14px;
      min-height: 42px;
      border: 0;
      border-radius: 6px;
      background: var(--site-accent);
      color: var(--site-button-text);
      font-weight: 900;
      cursor: pointer;
    }
    .site-report-panel button:disabled { opacity: 0.55; cursor: not-allowed; }
    .site-report-panel .form-link {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      margin-top: 14px;
      min-height: 42px;
      border-radius: 6px;
      background: var(--site-accent);
      color: var(--site-button-text);
      font-weight: 900;
      text-decoration: none;
    }
    .site-report-form-note { margin-top: 12px; color: var(--site-muted); font-size: 0.82rem; line-height: 1.4; }
    .site-report-form-success { margin-top: 12px; color: var(--site-success); font-size: 0.88rem; font-weight: 800; }
    .site-report-form-error { margin-top: 12px; color: var(--site-danger); font-size: 0.88rem; font-weight: 800; }
    @media (max-width: 760px) {
      body { padding: 24px 12px 40px !important; }
      .site-menu-button { top: 12px; left: 12px; }
      .site-report-footer { width: calc(100% - 24px); }
    }
  </style>`,
    menu: `<button type="button" class="site-menu-button" id="siteMenuButton" aria-label="Open report menu" aria-controls="siteReportDrawer" aria-expanded="false">&#9776;</button>
  <div class="site-report-backdrop" data-site-menu-close></div>
  <nav class="site-report-drawer" id="siteReportDrawer" aria-label="Report menu">
    <div class="site-drawer-header">
      <div>
        <div class="site-drawer-kicker">Kruse Report</div>
        <div class="site-drawer-title">${esc(dateLabel)}</div>
      </div>
      <button type="button" class="site-drawer-close" data-site-menu-close aria-label="Close report menu">&times;</button>
    </div>
    <a class="site-drawer-link" href="../index.html"><strong>All reports</strong><span>Back to the archive.</span></a>
    <a class="site-drawer-link" href="../latest/"><strong>Latest report</strong><span>Jump to the newest daily report.</span></a>
    <a class="site-drawer-link" href="#get-report"><strong>Get this report</strong><span>Email signup lives at the end of this report.</span></a>
    <a class="site-drawer-link" href="#report-feedback"><strong>Improve this report</strong><span>Leave feedback we can use later for prompt tuning.</span></a>
  </nav>`,
    footer: `<div class="site-report-footer">
    <section class="site-report-panel" id="get-report" aria-labelledby="get-report-title">
      <h2 id="get-report-title">Get this report</h2>
      <p>Leave an email and we will add you when delivery opens.</p>
      <form name="kruse-report-interest" ${formAttrs('mailing-list', isGoogleSignupFormReady())}>
        ${hiddenInput('form_type', 'kruse-report-interest', GOOGLE_FORM_ENTRIES.type)}
        ${hiddenInput('report_date', report.date, GOOGLE_FORM_ENTRIES.reportDate)}
        ${hiddenInput('report_url', publicUrl(`reports/${report.name}`), GOOGLE_FORM_ENTRIES.reportUrl)}
        <p style="display:none"><label>Company <input name="company" /></label></p>
        <label for="report-first-name-${esc(report.date)}">First name</label>
        <input id="report-first-name-${esc(report.date)}" name="${esc(fieldName('first_name', GOOGLE_FORM_ENTRIES.name))}" autocomplete="given-name"${disabledAttr(signupReady)} />
        <label for="report-last-name-${esc(report.date)}">Last name</label>
        <input id="report-last-name-${esc(report.date)}" name="${esc(fieldName('last_name'))}" autocomplete="family-name"${disabledAttr(signupReady)} />
        <label for="report-email-${esc(report.date)}">Email</label>
        <input id="report-email-${esc(report.date)}" name="${esc(fieldName('email', GOOGLE_FORM_ENTRIES.email))}" type="email" autocomplete="email" required${disabledAttr(signupReady)} />
        <label for="report-frequency-${esc(report.date)}">Delivery</label>
        <select id="report-frequency-${esc(report.date)}" name="${esc(fieldName('frequency', GOOGLE_FORM_ENTRIES.frequency))}"${disabledAttr(signupReady)}>
          <option>Daily</option>
          <option>Only strong signal days</option>
          <option>Weekly digest</option>
        </select>
        <label for="report-comments-${esc(report.date)}">Comments</label>
        <textarea id="report-comments-${esc(report.date)}" name="${esc(fieldName('comments'))}"${disabledAttr(signupReady)}></textarea>
        ${submitControl(signupReady, 'Join list', 'Open signup form')}
        <div class="site-report-form-success" data-form-success hidden>Saved. You are on the list.</div>
        <div class="site-report-form-error" data-form-error hidden>Could not save. Please try again.</div>
      </form>
      <div class="site-report-form-note">${formStorageNote('mailing-list', signupReady)}</div>
    </section>
    <section class="site-report-panel" id="report-feedback" aria-labelledby="report-feedback-title">
      <h2 id="report-feedback-title">Improve future reports</h2>
      <p>Tell us what was useful, confusing, missing, or too AI-ish. We will use this later to tune prompts.</p>
      <form name="kruse-report-feedback" ${formAttrs('feedback', isGoogleFeedbackFormReady())}>
        ${hiddenInput('form_type', 'kruse-report-feedback', GOOGLE_FORM_ENTRIES.type)}
        ${hiddenInput('report_date', report.date, GOOGLE_FORM_ENTRIES.reportDate)}
        ${hiddenInput('report_url', publicUrl(`reports/${report.name}`), GOOGLE_FORM_ENTRIES.reportUrl)}
        <p style="display:none"><label>Website <input name="website" /></label></p>
        <label for="feedback-first-name-${esc(report.date)}">First name</label>
        <input id="feedback-first-name-${esc(report.date)}" name="${esc(fieldName('first_name', GOOGLE_FORM_ENTRIES.name))}" autocomplete="given-name"${disabledAttr(feedbackReady)} />
        <label for="feedback-last-name-${esc(report.date)}">Last name</label>
        <input id="feedback-last-name-${esc(report.date)}" name="${esc(fieldName('last_name'))}" autocomplete="family-name"${disabledAttr(feedbackReady)} />
        <label for="feedback-rating-${esc(report.date)}">Overall</label>
        <select id="feedback-rating-${esc(report.date)}" name="${esc(fieldName('rating', GOOGLE_FORM_ENTRIES.rating))}"${disabledAttr(feedbackReady)}>
          <option>Useful</option>
          <option>Mixed</option>
          <option>Bad</option>
        </select>
        <label for="feedback-text-${esc(report.date)}">Feedback</label>
        <textarea id="feedback-text-${esc(report.date)}" name="${esc(fieldName('comments', GOOGLE_FORM_ENTRIES.feedback))}" required${disabledAttr(feedbackReady)}></textarea>
        <label for="feedback-email-${esc(report.date)}">Email (optional)</label>
        <input id="feedback-email-${esc(report.date)}" name="${esc(fieldName('email', GOOGLE_FORM_ENTRIES.email))}" type="email" autocomplete="email"${disabledAttr(feedbackReady)} />
        ${submitControl(feedbackReady, 'Send feedback', 'Open feedback form')}
        <div class="site-report-form-success" data-form-success hidden>Saved. Thank you.</div>
        <div class="site-report-form-error" data-form-error hidden>Could not save. Please try again.</div>
      </form>
      <div class="site-report-form-note">${formStorageNote('feedback', feedbackReady)}</div>
    </section>
  </div>`,
    script: `<script>
    (function () {
      var button = document.getElementById('siteMenuButton');
      var drawer = document.getElementById('siteReportDrawer');
      if (!button || !drawer) return;

      function setOpen(open) {
        document.body.classList.toggle('site-drawer-open', open);
        button.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) {
          var focusTarget = drawer.querySelector('a, button');
          if (focusTarget) focusTarget.focus();
        } else {
          button.focus();
        }
      }

      button.addEventListener('click', function () {
        setOpen(!document.body.classList.contains('site-drawer-open'));
      });

      var closeTargets = document.querySelectorAll('[data-site-menu-close], .site-drawer-link');
      for (var i = 0; i < closeTargets.length; i++) {
        closeTargets[i].addEventListener('click', function () { setOpen(false); });
      }

      document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') setOpen(false);
      });
    })();
  </script>`,
  };
}

function decorateReportHtml(html, report) {
  const chrome = reportSiteChrome(report);
  let out = html;
  if (out.includes('</head>')) out = out.replace('</head>', `${chrome.style}\n</head>`);
  const headEnd = out.toLowerCase().indexOf('</head>');
  const bodySearchStart = headEnd >= 0 ? headEnd : 0;
  const bodyMatch = out.slice(bodySearchStart).match(/<body([^>]*)>/i);
  if (bodyMatch) {
    const bodyStart = bodySearchStart + bodyMatch.index;
    const bodyEnd = bodyStart + bodyMatch[0].length;
    out = `${out.slice(0, bodyStart)}<body${bodyMatch[1]}>\n${chrome.menu}\n${googleFormIframe()}${out.slice(bodyEnd)}`;
  }
  return out.includes('</body>')
    ? out.replace('</body>', `${chrome.footer}\n${chrome.script}\n${supabaseFormScript()}\n${googleFormScript()}\n</body>`)
    : `${out}\n${chrome.footer}\n${chrome.script}\n${supabaseFormScript()}\n${googleFormScript()}`;
}

function copyReports(reports) {
  for (const report of reports) {
    const html = readFileSync(report.sourcePath, 'utf8');
    writeFileSync(path.join(SITE_REPORTS_DIR, report.name), decorateReportHtml(html, report), 'utf8');
  }
}

function buildSite() {
  const reports = reportFiles();
  rmSync(SITE_DIR, { recursive: true, force: true });
  mkdirSync(SITE_REPORTS_DIR, { recursive: true });
  mkdirSync(SITE_LATEST_DIR, { recursive: true });
  copyReports(reports);
  writeFileSync(path.join(SITE_DIR, 'index.html'), renderIndex(reports), 'utf8');
  writeFileSync(path.join(SITE_DIR, 'thanks.html'), renderThanks(), 'utf8');
  writeFileSync(path.join(SITE_LATEST_DIR, 'index.html'), renderLatestRedirect(reports[reports.length - 1]), 'utf8');
  writeFileSync(path.join(SITE_DIR, '.nojekyll'), '', 'utf8');
  if (reports.length) {
    const latest = reports[reports.length - 1];
    writeFileSync(path.join(SITE_DIR, '_redirects'), `/latest /reports/${latest.name} 302\n/latest/ /reports/${latest.name} 302\n`, 'utf8');
  }
  writeFileSync(path.join(SITE_DIR, '_headers'), `/*
  X-Frame-Options: SAMEORIGIN
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
`, 'utf8');
  console.log(`built site with ${reports.length} reports at ${path.relative(ROOT, SITE_DIR)}`);
}

buildSite();
