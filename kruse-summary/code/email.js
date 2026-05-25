// Gmail SMTP via nodemailer. Free. Uses a Google App Password.
//
// Setup:
//   1. Enable 2FA on the sending Gmail account.
//   2. Generate App Password at https://myaccount.google.com/apppasswords
//   3. Put it in GMAIL_APP_PASSWORD (or repo secret).
//
// Gmail sending cap: about 500 outbound/day per account. Fine for a small list.

import nodemailer from 'nodemailer';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS } from '../settings.js';
import { info } from './logger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_BASE_URL = process.env.KRUSE_SITE_PUBLIC_BASE_URL || 'https://guyhouri.github.io/kruse-ai-scrape';

function loadMailingList() {
  const p = path.join(ROOT, SETTINGS.mailingListPath);
  if (!existsSync(p)) throw new Error(`mailing list not found: ${p}`);
  const json = JSON.parse(readFileSync(p, 'utf8'));
  if (!Array.isArray(json.recipients) || !json.recipients.length) {
    throw new Error('mailing_list.json has empty recipients[]');
  }
  return json.recipients;
}

function buildTransport() {
  if (!SETTINGS.gmailUser || !SETTINGS.gmailAppPassword) {
    throw new Error('GMAIL_USER / GMAIL_APP_PASSWORD not set');
  }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: SETTINGS.gmailUser,
      pass: SETTINGS.gmailAppPassword.replace(/\s+/g, ''),
    },
  });
}

function reportDateFromDisplay(dateDisplay) {
  const match = String(dateDisplay || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return '';
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function reportUrlForDateDisplay(dateDisplay) {
  const date = reportDateFromDisplay(dateDisplay);
  if (!date) return PUBLIC_BASE_URL;
  return new URL(`reports/${date}.html`, `${PUBLIC_BASE_URL.replace(/\/+$/, '')}/`).toString();
}

// Build a short plain-text + minimal HTML body for the email itself, with
// the full report attached as an HTML file. Gmail strips inline <script>
// so attachment lets the user open the full interactive report in a browser.
export async function sendReportEmail({ subject, html, dateDisplay, attachmentName, reportUrl }) {
  const recipients = loadMailingList();
  const transport = buildTransport();
  const bcc = recipients.map((r) => r.email).join(', ');
  info(`sending "${subject}" to ${recipients.length} recipient(s) via BCC`);

  const filename = attachmentName || `kruse-report-${(dateDisplay || 'today').replace(/\//g, '-')}.html`;
  const websiteUrl = reportUrl || reportUrlForDateDisplay(dateDisplay);

  const textBody = [
    `Kruse pipeline ${dateDisplay || ''}`,
    '',
    `Website report: ${websiteUrl}`,
    '',
    'The full interactive report is attached as an HTML file.',
    'Open the attachment in any browser for click-to-expand concepts.',
    '',
    'An inline preview follows below.',
  ].join('\n');

  const htmlWithLink = [
    '<div style="margin:0 0 18px;padding:14px 16px;border:1px solid #26334d;border-radius:8px;background:#0b0f19;color:#f4f7fb;font-family:Inter,Arial,sans-serif">',
    `<strong>Kruse pipeline ${dateDisplay || ''}</strong><br />`,
    `<a href="${websiteUrl}" style="color:#4ea1ff;font-weight:700">Open today's website report</a>`,
    '</div>',
    html,
  ].join('');

  const info_ = await transport.sendMail({
    from: `"${SETTINGS.fromName}" <${SETTINGS.gmailUser}>`,
    to: SETTINGS.gmailUser,
    bcc,
    subject,
    text: textBody,
    html: htmlWithLink,
    attachments: [
      {
        filename,
        content: html,
        contentType: 'text/html; charset=utf-8',
      },
    ],
    headers: {
      'X-Kruse-Summary-Date': dateDisplay || '',
      'X-Kruse-Report-Url': websiteUrl,
    },
  });

  info(`sent: messageId=${info_.messageId}, response=${info_.response}`);
  return info_;
}
