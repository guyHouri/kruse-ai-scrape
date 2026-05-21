// Central knobs for twitter_to_md.
// Override via .env or env vars — see .env.example.

import 'dotenv/config';

export const SETTINGS = {
  // Target user. No leading @.
  handle: process.env.TWITTER_HANDLE || 'DrJackKruse',

  // Official X API v2 Bearer Token (App-only auth).
  // Get from https://developer.x.com/en/portal/dashboard
  // Pay-per-tweet pricing as of 2026; see https://docs.x.com/x-api/getting-started/pricing
  xBearerToken: process.env.XAPI_BEARER_TOKEN || '',

  apiBaseUrl: 'https://api.x.com/2',

  // Safety cap per day. Kruse posts <50/day → 100 covers 2× spikes.
  // In test mode (--test) overridden to 2.
  maxItemsPerDay: 100,

  // Reply-chain resolution: how deep to walk parents.
  // Each level = 1 extra API call (single-tweet GET).
  // In test mode overridden to 0.
  maxThreadDepth: 6,

  // Output dirs (relative to package root).
  dataDir: 'data',
  indexFile: 'data/index.json',
  logsDir: 'logs',

  // Cost-awareness: refuse to start a run if the projected tweet count
  // (maxItemsPerDay + depth-cap parents) would cost more than this.
  // At $0.005/tweet, 250 tweets ≈ $1.25. Bump if you need bigger backfills.
  maxProjectedCostUsd: 1.5,
  costPerTweetUsd: 0.005,
};
