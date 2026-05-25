// Pull public signup submissions from Google Forms/Sheets or FormSubmit and
// merge them into the sender's canonical mailing_list.json.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAILING_LIST_PATH = path.isAbsolute(process.env.MAILING_LIST_PATH || '')
  ? process.env.MAILING_LIST_PATH
  : path.join(ROOT, process.env.MAILING_LIST_PATH || 'mailing_list.json');
const GOOGLE_SHEET_CSV_URL = process.env.GOOGLE_FORM_RESPONSES_CSV_URL || '';
const API_KEY = process.env.FORMSUBMIT_API_KEY || '';
const API_URL = process.env.FORMSUBMIT_SUBMISSIONS_URL || (
  API_KEY ? `https://formsubmit.co/api/get-submissions/${encodeURIComponent(API_KEY)}` : ''
);

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function clean(value) {
  return String(value || '').trim();
}

function normalizeKey(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function loadMailingList() {
  if (!existsSync(MAILING_LIST_PATH)) return { recipients: [] };
  const parsed = JSON.parse(readFileSync(MAILING_LIST_PATH, 'utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(parsed.recipients)) parsed.recipients = [];
  return parsed;
}

function submittedAtValue(submission) {
  const submittedAt = submission?.submitted_at;
  if (typeof submittedAt === 'string') return submittedAt;
  if (submittedAt?.date) return submittedAt.date;
  return new Date().toISOString();
}

function formDataOf(submission) {
  return submission?.form_data && typeof submission.form_data === 'object'
    ? submission.form_data
    : {};
}

function isSignupSubmission(data) {
  const formName = clean(data['form-name'] || data.form_name || data.formName).toLowerCase();
  const subject = clean(data._subject || data.subject).toLowerCase();
  if (formName === 'kruse-report-feedback' || subject.includes('feedback')) return false;
  if (formName === 'kruse-report-interest') return true;
  if (subject.includes('kruse report request') || subject.includes('mailing-list request')) return true;
  return Boolean(data.email && (data.frequency || data.report_date || data.source_page));
}

function submissionToRecipient(submission) {
  const data = formDataOf(submission);
  if (!isSignupSubmission(data)) return null;
  const email = normalizeEmail(data.email);
  if (!email) return null;
  return {
    email,
    name: clean(data.name),
    frequency: clean(data.frequency) || 'Daily',
    source: 'public-site',
    reportDate: clean(data.report_date),
    reportUrl: clean(data.report_url || data.source_page),
    subscribedAt: submittedAtValue(submission),
  };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      row.push(field);
      field = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(field);
      if (row.some((cell) => clean(cell))) rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  row.push(field);
  if (row.some((cell) => clean(cell))) rows.push(row);
  return rows;
}

function rowValue(row, aliases) {
  for (const alias of aliases) {
    const value = row[normalizeKey(alias)];
    if (value !== undefined && value !== null && clean(value)) return clean(value);
  }
  return '';
}

function googleRowToRecipient(row) {
  const formName = rowValue(row, ['form-name', 'form name', 'type', 'submission type']).toLowerCase();
  const feedback = rowValue(row, ['feedback', 'comment', 'comments']);
  if (formName && formName !== 'kruse-report-interest') return null;
  if (!formName && feedback) return null;

  const email = normalizeEmail(rowValue(row, ['email', 'email address']));
  if (!email) return null;

  return {
    email,
    name: rowValue(row, ['name', 'full name']),
    frequency: rowValue(row, ['delivery', 'frequency']) || 'Daily',
    source: 'google-forms',
    reportDate: rowValue(row, ['report date', 'report_date', 'date']),
    reportUrl: rowValue(row, ['report url', 'report_url', 'source page']),
    subscribedAt: rowValue(row, ['timestamp', 'submitted at', 'submitted_at']) || new Date().toISOString(),
  };
}

async function fetchGoogleSheetRecipients() {
  if (!GOOGLE_SHEET_CSV_URL) return null;
  const response = await fetch(GOOGLE_SHEET_CSV_URL, { headers: { accept: 'text/csv' } });
  if (!response.ok) {
    throw new Error(`Google Sheet CSV returned ${response.status}: ${await response.text()}`);
  }
  const rows = parseCsv(await response.text());
  if (!rows.length) return [];

  const headers = rows[0].map(normalizeKey);
  return rows.slice(1).map((cells) => {
    const row = {};
    for (let i = 0; i < headers.length; i += 1) row[headers[i]] = cells[i] || '';
    return googleRowToRecipient(row);
  }).filter(Boolean);
}

function mergeRecipients(current, incoming) {
  const byEmail = new Map();
  for (const recipient of current.recipients) {
    const email = normalizeEmail(recipient.email);
    if (!email) continue;
    byEmail.set(email, { ...recipient, email });
  }

  let added = 0;
  let updated = 0;
  for (const recipient of incoming) {
    const existing = byEmail.get(recipient.email);
    if (!existing) {
      byEmail.set(recipient.email, recipient);
      added += 1;
      continue;
    }

    const merged = {
      ...existing,
      name: recipient.name || existing.name,
      frequency: recipient.frequency || existing.frequency || 'Daily',
      source: existing.source || recipient.source,
      reportDate: recipient.reportDate || existing.reportDate,
      reportUrl: recipient.reportUrl || existing.reportUrl,
      subscribedAt: existing.subscribedAt || recipient.subscribedAt,
      updatedAt: new Date().toISOString(),
    };
    if (JSON.stringify(existing) !== JSON.stringify(merged)) updated += 1;
    byEmail.set(recipient.email, merged);
  }

  return {
    mailingList: {
      ...current,
      updatedAt: new Date().toISOString(),
      recipients: Array.from(byEmail.values()).sort((a, b) => a.email.localeCompare(b.email)),
    },
    added,
    updated,
  };
}

async function fetchSubmissions() {
  const googleRecipients = await fetchGoogleSheetRecipients();
  if (googleRecipients) {
    console.log(`loaded ${googleRecipients.length} signup(s) from Google Sheet CSV.`);
    return googleRecipients;
  }

  if (!API_URL) {
    console.log('GOOGLE_FORM_RESPONSES_CSV_URL/FORMSUBMIT_API_KEY are not set; skipping mailing-list sync.');
    return [];
  }
  const response = await fetch(API_URL, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`FormSubmit API returned ${response.status}: ${await response.text()}`);
  }
  const payload = await response.json();
  if (payload.success === false) {
    throw new Error(`FormSubmit API error: ${payload.message || 'unknown error'}`);
  }
  return Array.isArray(payload.submissions) ? payload.submissions : [];
}

async function main() {
  const submissions = await fetchSubmissions();
  const incoming = submissions.every((item) => item?.email)
    ? submissions
    : submissions.map(submissionToRecipient).filter(Boolean);
  const current = loadMailingList();
  const before = current.recipients.length;
  const { mailingList, added, updated } = mergeRecipients(current, incoming);

  if (!added && !updated) {
    console.log(`mailing list unchanged (${before} recipient${before === 1 ? '' : 's'}).`);
    return;
  }

  writeFileSync(MAILING_LIST_PATH, `${JSON.stringify(mailingList, null, 2)}\n`, 'utf8');
  console.log(`mailing list synced: ${added} added, ${updated} updated, ${mailingList.recipients.length} total.`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
