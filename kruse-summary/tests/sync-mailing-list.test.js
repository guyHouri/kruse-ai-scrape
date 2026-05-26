import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchSupabaseRecipientsFrom,
  googleRowToRecipient,
  isUnsubscribeRow,
  mergeRecipients,
  normalizeEmail,
  parseCsv,
  supabaseRowToRecipient,
  supabaseRowsToSyncState,
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
  assert.equal(isUnsubscribeRow({ email: 'x@example.com', source: 'unsubscribe' }), true);
  assert.equal(isUnsubscribeRow({ email: 'x@example.com', frequency: 'Unsubscribe' }), true);
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

test('mergeRecipients removes unsubscribe requests from the sender list', () => {
  const current = {
    recipients: [
      { email: 'guy.houri2024@gmail.com', name: 'Guy', frequency: 'Daily', source: 'manual' },
      { email: 'other@example.com', name: 'Other', frequency: 'Daily', source: 'manual' },
    ],
  };

  const { mailingList, added, updated, removed } = mergeRecipients(
    current,
    [{ email: 'new@example.com', name: 'New Reader', frequency: 'Daily', source: 'supabase' }],
    ['guy.houri2024@gmail.com'],
  );

  assert.equal(added, 1);
  assert.equal(updated, 0);
  assert.equal(removed, 1);
  assert.deepEqual(mailingList.recipients.map((r) => r.email), ['new@example.com', 'other@example.com']);
});

test('Supabase sync treats the newest database row as signup or unsubscribe state', () => {
  const unsubscribeLatest = supabaseRowsToSyncState([
    {
      email: 'reader@example.com',
      first_name: 'Reader',
      last_name: 'One',
      frequency: 'Daily',
      source: 'public-site',
      created_at: '2026-05-26T08:00:00Z',
    },
    {
      email: 'reader@example.com',
      frequency: 'Unsubscribe',
      source: 'unsubscribe',
      created_at: '2026-05-26T09:00:00Z',
    },
  ]);
  assert.deepEqual(unsubscribeLatest.recipients, []);
  assert.deepEqual(unsubscribeLatest.unsubscribedEmails, ['reader@example.com']);

  const signupLatest = supabaseRowsToSyncState([
    {
      email: 'reader@example.com',
      frequency: 'Unsubscribe',
      source: 'unsubscribe',
      created_at: '2026-05-26T08:00:00Z',
    },
    {
      email: 'reader@example.com',
      first_name: 'Reader',
      last_name: 'Return',
      frequency: 'Daily',
      source: 'public-site',
      created_at: '2026-05-26T09:00:00Z',
    },
  ]);
  assert.equal(signupLatest.recipients.length, 1);
  assert.equal(signupLatest.recipients[0].email, 'reader@example.com');
  assert.equal(signupLatest.recipients[0].name, 'Reader Return');
  assert.deepEqual(signupLatest.unsubscribedEmails, []);
});

test('fetchSupabaseRecipientsFrom reads DB rows and sends service-role headers', async () => {
  let requestedUrl = null;
  let requestedHeaders = null;
  const result = await fetchSupabaseRecipientsFrom({
    supabaseUrl: 'https://example.supabase.co/',
    serviceRoleKey: 'test-service-role-key',
    table: 'kruse_mailing_list',
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      requestedHeaders = options.headers;
      return {
        ok: true,
        text: async () => JSON.stringify([
          {
            email: 'new@example.com',
            first_name: 'New',
            last_name: 'Reader',
            frequency: 'Daily',
            source: 'public-site',
            created_at: '2026-05-26T10:00:00Z',
          },
          {
            email: 'gone@example.com',
            frequency: 'Unsubscribe',
            source: 'unsubscribe',
            created_at: '2026-05-26T11:00:00Z',
          },
        ]),
      };
    },
  });

  assert.equal(requestedUrl.origin, 'https://example.supabase.co');
  assert.equal(requestedUrl.pathname, '/rest/v1/kruse_mailing_list');
  assert.equal(requestedUrl.searchParams.get('order'), 'created_at.desc');
  assert.equal(requestedHeaders.apikey, 'test-service-role-key');
  assert.equal(requestedHeaders.authorization, 'Bearer test-service-role-key');
  assert.deepEqual(result.recipients.map((r) => r.email), ['new@example.com']);
  assert.deepEqual(result.unsubscribedEmails, ['gone@example.com']);
});
