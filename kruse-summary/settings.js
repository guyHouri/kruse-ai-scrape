// Central knobs for kruse-summary.
// Override via .env / env vars (GH Actions secrets) — see .env.example.

import 'dotenv/config';

export const SETTINGS = {
  // Where the scraped tweet JSONs live (relative to this package).
  // Default points at the sibling twitter_to_md/data dir.
  scrapedDataDir: process.env.SCRAPED_DATA_DIR || '../twitter_to_md/data',

  // Where the daily forum scrape JSONs live. Optional — if the file for the
  // report date is absent, the Forum Insights section is skipped.
  forumDailyDir: process.env.FORUM_DAILY_DIR || '../forum_to_md/daily',

  // Gmail credentials. Use a Google App Password, NOT your account password.
  // Create one: https://myaccount.google.com/apppasswords
  gmailUser: process.env.GMAIL_USER || '',
  gmailAppPassword: process.env.GMAIL_APP_PASSWORD || '',

  // From-line for outgoing mail.
  fromName: process.env.FROM_NAME || 'Kruse Daily',

  // Geo for sunrise lookup. Defaults to Jerusalem; override via env.
  locationLat: parseFloat(process.env.LOCATION_LAT || '31.7683'),
  locationLon: parseFloat(process.env.LOCATION_LON || '35.2137'),

  // Minutes before sunrise we want the mail to land.
  preSunriseMinutes: parseInt(process.env.PRE_SUNRISE_MINUTES || '60', 10),

  // Hourly cron will fire several times in a window. We only act when "now"
  // is inside [target - tolerance, target + tolerance]. 30 min window.
  toleranceMinutes: parseInt(process.env.TOLERANCE_MINUTES || '30', 10),

  // Sunrise API (no auth, no key). Returns ISO UTC.
  sunriseApiUrl: 'https://api.sunrise-sunset.org/json',

  // Local files.
  mailingListPath: 'mailing_list.json',
  lastSentPath: 'last-sent.json',
};
