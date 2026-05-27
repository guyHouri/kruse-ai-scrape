import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyTestRecipientGate,
  parseTestRecipients,
} from '../code/email.js';

test('parseTestRecipients accepts comma, semicolon, and whitespace separated addresses', () => {
  assert.deepEqual(
    parseTestRecipients(' Guy.Houri2024@GMAIL.COM, other@example.com; third@example.com '),
    ['guy.houri2024@gmail.com', 'other@example.com', 'third@example.com'],
  );
});

test('applyTestRecipientGate sends only to approved test recipients', () => {
  const recipients = [
    { email: 'reader@example.com', name: 'Reader' },
    { email: 'Guy.Houri2024@GMAIL.COM', name: 'Guy Houri' },
  ];

  assert.deepEqual(
    applyTestRecipientGate(recipients, 'guy.houri2024@gmail.com'),
    [{ email: 'guy.houri2024@gmail.com', name: 'Guy Houri' }],
  );
});

test('applyTestRecipientGate can synthesize a test recipient if the synced list is empty', () => {
  assert.deepEqual(
    applyTestRecipientGate([], 'guy.houri2024@gmail.com'),
    [{ email: 'guy.houri2024@gmail.com', name: '' }],
  );
});
