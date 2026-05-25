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

function displayName(recipient) {
  return String(recipient?.name || '').trim() || 'there';
}

// Send a tiny link-only email. The public website is the source of truth; the
// inbox should not receive the whole HTML report or an attachment.
export async function sendReportEmail({ subject, dateDisplay, reportUrl }) {
  const recipients = loadMailingList();
  const transport = buildTransport();
  const websiteUrl = reportUrl || reportUrlForDateDisplay(dateDisplay);
  info(`sending "${subject}" to ${recipients.length} recipient(s) individually`);

  const results = [];
  for (const recipient of recipients) {
    const name = displayName(recipient);
    const textBody = [
      `Hi ${name},`,
      '',
      '"Does Nature Make Mistakes?"',
      '',
      `Daily Kruse Summary ${dateDisplay || ''}:`,
      websiteUrl,
    ].join('\n');

    const htmlBody = [
      `<p>Hi ${name},</p>`,
      '<p><strong>"Does Nature Make Mistakes?"</strong></p>',
      `<p><a href="${websiteUrl}">Daily Kruse Summary ${dateDisplay || ''}</a></p>`,
    ].join('\n');

    const info_ = await transport.sendMail({
      from: `"${SETTINGS.fromName}" <${SETTINGS.gmailUser}>`,
      to: recipient.email,
      subject,
      text: textBody,
      html: htmlBody,
      headers: {
        'X-Kruse-Summary-Date': dateDisplay || '',
        'X-Kruse-Report-Url': websiteUrl,
      },
    });
    results.push(info_);
    info(`sent to ${recipient.email}: messageId=${info_.messageId}, response=${info_.response}`);
  }

  return results;
}
