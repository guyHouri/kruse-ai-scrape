// Track which date the report was last sent for, to prevent duplicate sends
// across manual retries, dispatch retries, or delayed scheduled runs.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS } from '../settings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_PATH = path.join(ROOT, SETTINGS.lastSentPath);

export function readState() {
  if (!existsSync(STATE_PATH)) return { last_sent_for_date: null, last_sent_at: null };
  return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
}

export function writeState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

// Returns true if we've already sent for `targetDate` (YYYY-MM-DD).
export function alreadySent(targetDate) {
  return readState().last_sent_for_date === targetDate;
}

export function markSent(targetDate) {
  writeState({
    last_sent_for_date: targetDate,
    last_sent_at: new Date().toISOString(),
  });
}

export function shouldMarkSentAfterEmail({
  testRecipientsValue = process.env.KRUSE_EMAIL_TEST_RECIPIENTS || '',
  skipMarkValue = process.env.KRUSE_SKIP_LAST_SENT_MARK || '',
} = {}) {
  if (String(testRecipientsValue || '').trim()) return false;
  return !['1', 'true', 'yes'].includes(String(skipMarkValue || '').trim().toLowerCase());
}
