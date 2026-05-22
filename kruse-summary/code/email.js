// Gmail SMTP via nodemailer. Free. Uses a Google App Password.
//
// Setup:
//   1. Enable 2FA on the sending Gmail account.
//   2. Generate App Password at https://myaccount.google.com/apppasswords
//   3. Put it in GMAIL_APP_PASSWORD (or repo secret).
//
// Gmail sending cap: ~500 outbound/day per account. Fine for a small list.

import nodemailer from 'nodemailer';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS } from '../settings.js';
import { info } from './logger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

// Build a short plain-text + minimal HTML body for the email itself, with
// the full report attached as an HTML file. Gmail strips inline <script>
// so attachment lets the user open the full interactive report in a
// browser tab and click the expandable concepts.
//
// Args:
//   subject       : email subject
//   html          : full report HTML (used for attachment AND inline preview)
//   dateDisplay   : e.g. "22/05/2026", used in subject + attachment name
//   attachmentName: optional override for attachment filename
export async function sendReportEmail({ subject, html, dateDisplay, attachmentName }) {
  const recipients = loadMailingList();
  const transport = buildTransport();
  const bcc = recipients.map((r) => r.email).join(', ');
  info(`sending "${subject}" to ${recipients.length} recipient(s) via BCC`);

  const filename = attachmentName || `kruse-report-${(dateDisplay || 'today').replace(/\//g, '-')}.html`;

  const textBody = [
    `Kruse Daily Summary — ${dateDisplay || ''}`,
    '',
    'The full interactive report is attached as an HTML file.',
    'Open the attachment in any browser for click-to-expand concepts.',
    '',
    'An inline preview follows below (some interactivity may be stripped by your mail client).',
  ].join('\n');

  // Inline preview = the report HTML itself. Mail clients render most of it;
  // JS-driven expanders won't fire inside Gmail's sandbox, hence attachment.
  const info_ = await transport.sendMail({
    from: `"${SETTINGS.fromName}" <${SETTINGS.gmailUser}>`,
    to: SETTINGS.gmailUser,
    bcc,
    subject,
    text: textBody,
    html,
    attachments: [
      {
        filename,
        content: html,
        contentType: 'text/html; charset=utf-8',
      },
    ],
    headers: {
      'X-Kruse-Summary-Date': dateDisplay || '',
    },
  });

  info(`sent: messageId=${info_.messageId}, response=${info_.response}`);
  return info_;
}
