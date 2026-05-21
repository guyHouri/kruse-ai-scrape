// Gmail SMTP via nodemailer. Free. Requires a Google App Password.
//
// Setup:
//   1. Enable 2FA on guyhouri.tech@gmail.com (already done if signed up post-2024).
//   2. Generate App Password at https://myaccount.google.com/apppasswords.
//   3. Put it in GMAIL_APP_PASSWORD (or repo secret).
//
// Sending limits: Gmail allows ~500 outbound/day per account. Fine for a
// daily newsletter to a small list. Bigger lists → use a real ESP (Resend, etc).

import nodemailer from 'nodemailer';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS } from '../settings.js';
import { info, error } from './logger.js';

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
      pass: SETTINGS.gmailAppPassword.replace(/\s+/g, ''), // tolerate "xxxx xxxx ..." paste
    },
  });
}

// Send the report HTML to every recipient. We BCC them so addresses are not
// disclosed across the list. From/To are the same Gmail account.
export async function sendReportEmail({ subject, html, dateDisplay }) {
  const recipients = loadMailingList();
  const transport = buildTransport();

  const bcc = recipients.map((r) => r.email).join(', ');
  info(`sending "${subject}" to ${recipients.length} recipient(s) via BCC`);

  const info_ = await transport.sendMail({
    from: `"${SETTINGS.fromName}" <${SETTINGS.gmailUser}>`,
    to: SETTINGS.gmailUser,
    bcc,
    subject,
    html,
    headers: {
      'X-Kruse-Summary-Date': dateDisplay || '',
    },
  });

  info(`sent: messageId=${info_.messageId}, response=${info_.response}`);
  return info_;
}
