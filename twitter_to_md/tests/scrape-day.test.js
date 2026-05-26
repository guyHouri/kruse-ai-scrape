import test from 'node:test';
import assert from 'node:assert/strict';

import { capFutureEndTime } from '../code/scrape-day.js';

test('future X API end_time is capped to a safe current timestamp', () => {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const capped = new Date(capFutureEndTime(future));

  assert.ok(capped.getTime() <= Date.now() - 10_000);
  assert.ok(capped.getTime() >= Date.now() - 60_000);
});

test('past X API end_time is preserved', () => {
  const past = '2026-05-20T00:00:00.000Z';
  assert.equal(capFutureEndTime(past), past);
});
