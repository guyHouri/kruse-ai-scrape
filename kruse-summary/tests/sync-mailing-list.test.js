import test from 'node:test';
import assert from 'node:assert/strict';

import {
  googleRowToRecipient,
  mergeRecipients,
  normalizeEmail,
  parseCsv,
  supabaseRowToRecipient,
} from '../code/sync-mailing-list.js';

test('normalizes emails and parses quoted CSV fields', () => {
  assert.equal(normalizeEmail(' Guy.Houri2024@GMAIL.COM '), 'guy.houri2024@gmail.com');
  assert.equal(normalizeEmail('not-an-email'), '');

  const rows = parseCsv('Email,Comments\n"guy@example.com","line, with comma"\n');
  assert.deepEqual(rows, [
    ['Email', 'Comments'],
    ['guy@example.com', 'line, with comma'],
  ]);
});

test('maps Google and Supabase signup rows into sender recipients', () => {
  const google = googleRowToRecipient({
    email: 'Reader@Example.com',
    name: 'Reader One',
    delivery: 'Daily',
    reportdate: '2026-05-26',
    reporturl: 'https://example.com/report',
  });
  assert.equal(google.email, 'reader@example.com');
  assert.equal(google.name, 'Reader One');
  assert.equal(google.frequency, 'Daily');
  assert.equal(google.source, 'google-forms');
  assert.equal(google.reportDate, '2026-05-26');
  assert.equal(google.reportUrl, 'https://example.com/report');
  assert.ok(Date.parse(google.subscribedAt));

  const supabase = supabaseRowToRecipient({
    email: 'Guy.Houri2024@gmail.com',
    first_name: 'Guy',
    last_name: 'Houri',
    comments: 'send it',
    frequency: 'Daily',
    report_date: '2026-05-26',
    report_url: 'https://example.com/report',
    created_at: '2026-05-26T10:00:00Z',
  });

  assert.equal(supabase.email, 'guy.houri2024@gmail.com');
  assert.equal(supabase.name, 'Guy Houri');
  assert.equal(supabase.source, 'supabase');
});

test('mergeRecipients dedupes by email and keeps existing subscribers', () => {
  const current = {
    recipients: [
      { email: 'guy.houri2024@gmail.com', name: 'Guy', frequency: 'Daily', source: 'manual' },
    ],
  };
  const incoming = [
    {
      email: 'guy.houri2024@gmail.com',
      name: 'Guy Houri',
      comments: 'from supabase',
      frequency: 'Daily',
      source: 'supabase',
      subscribedAt: '2026-05-26T10:00:00Z',
    },
    { email: 'new@example.com', name: 'New Reader', frequency: 'Daily', source: 'supabase' },
  ];

  const { mailingList, added, updated } = mergeRecipients(current, incoming);

  assert.equal(added, 1);
  assert.equal(updated, 1);
  assert.equal(mailingList.recipients.length, 2);
  assert.equal(mailingList.recipients[0].email, 'guy.houri2024@gmail.com');
  assert.equal(mailingList.recipients[0].comments, 'from supabase');
});
