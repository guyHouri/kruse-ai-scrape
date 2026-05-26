// Pull signup submissions into the sender's canonical mailing_list.json.
// Preferred path is Supabase with a service-role key. Google Forms / Sheets
// remains as a fallback while migrating.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAILING_LIST_PATH = path.isAbsolute(process.env.MAILING_LIST_PATH || '')
  ? process.env.MAILING_LIST_PATH
  : path.join(ROOT, process.env.MAILING_LIST_PATH || 'mailing_list.json');
const GOOGLE_SHEET_CSV_URL = process.env.GOOGLE_FORM_RESPONSES_CSV_URL || '';
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
const GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 || '';
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || '';
const GOOGLE_SHEET_RANGE = process.env.GOOGLE_SHEET_RANGE || 'Form Responses 1!A:Z';
const SHEETS_READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_MAILING_LIST_TABLE = process.env.SUPABASE_MAILING_LIST_TABLE || 'kruse_mailing_list';

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

function nameFromParts(firstName, lastName) {
  return [clean(firstName), clean(lastName)].filter(Boolean).join(' ');
}

function supabaseRowToRecipient(row) {
  const email = normalizeEmail(row.email);
  if (!email) return null;
  return {
    email,
    name: nameFromParts(row.first_name, row.last_name),
    comments: clean(row.comments),
    frequency: clean(row.frequency) || 'Daily',
    source: 'supabase',
    reportDate: clean(row.report_date),
    reportUrl: clean(row.report_url),
    subscribedAt: clean(row.created_at) || new Date().toISOString(),
  };
}

async function fetchSupabaseRecipients() {
  if (!SUPABASE_URL && !SUPABASE_SERVICE_ROLE_KEY) return null;
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.log('SUPABASE_SERVICE_ROLE_KEY is not set; skipping Supabase mailing-list sync.');
    return null;
  }
  if (!SUPABASE_URL) {
    throw new Error('Supabase sync needs SUPABASE_URL when SUPABASE_SERVICE_ROLE_KEY is set.');
  }

  const url = new URL(`/rest/v1/${SUPABASE_MAILING_LIST_TABLE}`, SUPABASE_URL.replace(/\/+$/, ''));
  url.searchParams.set(
    'select',
    'email,first_name,last_name,comments,frequency,report_date,report_url,created_at'
  );
  url.searchParams.set('order', 'created_at.desc');

  const response = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase mailing-list fetch returned ${response.status}: ${bodyText}`);
  }

  const rows = JSON.parse(bodyText);
  const byEmail = new Map();
  for (const row of rows) {
    const recipient = supabaseRowToRecipient(row);
    if (recipient && !byEmail.has(recipient.email)) byEmail.set(recipient.email, recipient);
  }
  return Array.from(byEmail.values());
}

function base64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function parseServiceAccountCredentials() {
  const raw = GOOGLE_SERVICE_ACCOUNT_JSON_BASE64
    ? Buffer.from(GOOGLE_SERVICE_ACCOUNT_JSON_BASE64, 'base64').toString('utf8')
    : GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;

  const parsed = JSON.parse(raw);
  const credentials = {
    clientEmail: parsed.client_email,
    privateKey: String(parsed.private_key || '').replace(/\\n/g, '\n'),
  };
  if (!credentials.clientEmail || !credentials.privateKey) {
    throw new Error('Google service account credentials must include client_email and private_key.');
  }
  return credentials;
}

function createServiceAccountJwt(credentials) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: credentials.clientEmail,
    scope: SHEETS_READONLY_SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claim))}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(credentials.privateKey);
  return `${unsigned}.${base64Url(signature)}`;
}

async function getServiceAccountAccessToken(credentials) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: createServiceAccountJwt(credentials),
    }),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`Google OAuth token request returned ${response.status}: ${bodyText}`);
  }

  const body = JSON.parse(bodyText);
  if (!body.access_token) throw new Error('Google OAuth token response did not include access_token.');
  return body.access_token;
}

function rowsToRecipients(rows) {
  if (!rows.length) return [];

  const headers = rows[0].map(normalizeKey);
  return rows.slice(1).map((cells) => {
    const row = {};
    for (let i = 0; i < headers.length; i += 1) row[headers[i]] = cells[i] || '';
    return googleRowToRecipient(row);
  }).filter(Boolean);
}

async function fetchPrivateGoogleSheetRecipients() {
  const credentials = parseServiceAccountCredentials();
  if (!credentials && !GOOGLE_SHEET_ID) return null;
  if (!credentials || !GOOGLE_SHEET_ID) {
    throw new Error('Private Google Sheet sync needs GOOGLE_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_JSON_BASE64.');
  }

  const accessToken = await getServiceAccountAccessToken(credentials);
  const encodedRange = encodeURIComponent(GOOGLE_SHEET_RANGE);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(GOOGLE_SHEET_ID)}/values/${encodedRange}?majorDimension=ROWS`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`Google Sheets API returned ${response.status}: ${bodyText}`);
  }

  const body = JSON.parse(bodyText);
  return rowsToRecipients(body.values || []);
}

async function fetchGoogleSheetRecipients() {
  if (!GOOGLE_SHEET_CSV_URL) return null;
  const response = await fetch(GOOGLE_SHEET_CSV_URL, { headers: { accept: 'text/csv' } });
  if (!response.ok) {
    throw new Error(`Google Sheet CSV returned ${response.status}: ${await response.text()}`);
  }
  const rows = parseCsv(await response.text());
  return rowsToRecipients(rows);
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
      comments: recipient.comments || existing.comments,
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
  const supabaseRecipients = await fetchSupabaseRecipients();
  if (supabaseRecipients) {
    console.log(`loaded ${supabaseRecipients.length} signup(s) from Supabase.`);
    return supabaseRecipients;
  }

  const privateGoogleRecipients = await fetchPrivateGoogleSheetRecipients();
  if (privateGoogleRecipients) {
    console.log(`loaded ${privateGoogleRecipients.length} signup(s) from private Google Sheet.`);
    return privateGoogleRecipients;
  }

  const googleRecipients = await fetchGoogleSheetRecipients();
  if (googleRecipients) {
    console.log(`loaded ${googleRecipients.length} signup(s) from Google Sheet CSV.`);
    return googleRecipients;
  }

  console.log('GOOGLE_FORM_RESPONSES_CSV_URL is not set; skipping mailing-list sync.');
  return [];
}

async function main() {
  const submissions = await fetchSubmissions();
  const incoming = submissions;
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

export {
  fetchSubmissions,
  fetchSupabaseRecipients,
  googleRowToRecipient,
  mergeRecipients,
  normalizeEmail,
  parseCsv,
  submissionToRecipient,
  supabaseRowToRecipient,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
