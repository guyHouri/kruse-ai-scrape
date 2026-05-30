import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldMarkSentAfterEmail } from '../code/state.js';

test('normal sends update last-sent state', () => {
  assert.equal(shouldMarkSentAfterEmail(), true);
});

test('test-recipient sends do not update last-sent state', () => {
  assert.equal(
    shouldMarkSentAfterEmail({ testRecipientsValue: 'guy.houri2024@gmail.com' }),
    false,
  );
});

test('explicit skip mark flag prevents last-sent updates', () => {
  assert.equal(shouldMarkSentAfterEmail({ skipMarkValue: 'true' }), false);
  assert.equal(shouldMarkSentAfterEmail({ skipMarkValue: '1' }), false);
});
