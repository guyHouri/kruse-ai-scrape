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

  // Rolling input window ending at the end of the report date (UTC).
  summaryWindowHours: parseInt(process.env.SUMMARY_WINDOW_HOURS || '24', 10),

  // Calendar day used when no --date is supplied.
  reportTimeZone: process.env.REPORT_TIME_ZONE || 'Asia/Jerusalem',

  // Gmail credentials. Use a Google App Password, NOT your account password.
  // Create one: https://myaccount.google.com/apppasswords
  gmailUser: process.env.GMAIL_USER || '',
  gmailAppPassword: process.env.GMAIL_APP_PASSWORD || '',

  // From-line for outgoing mail.
  fromName: process.env.FROM_NAME || 'Kruse Daily',

  // Local files.
  mailingListPath: 'mailing_list.json',
  lastSentPath: 'last-sent.json',

  // Anthropic API for AI summarization.
  // Get a key at https://console.anthropic.com/settings/keys.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',

  // AI summary pipeline. "chain" runs selection -> evidence -> write -> editor.
  // "single" preserves the old one-shot summarizer for comparison/debugging.
  aiPipeline: process.env.KRUSE_AI_PIPELINE || 'chain',

  // Chained selector gate. Items below this priority stay in the audit but do
  // not proceed to evidence/writing, which keeps low-value filler out cheaply.
  aiSelectionMinPriority: parseInt(process.env.KRUSE_AI_SELECTION_MIN_PRIORITY || '4', 10),

  // Model. Haiku 4.5 = best price/quality for this content as of 2026.
  // Override via env if Anthropic publishes a newer alias or you want
  // higher reasoning (e.g. claude-sonnet-4-5).
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',

  // Max output tokens. Dense days with cards, concepts, citations, and forum
  // bullets can exceed 8 K output tokens, so default high enough to avoid
  // truncated JSON while still allowing env override.
  anthropicMaxTokens: parseInt(process.env.ANTHROPIC_MAX_TOKENS || '20000', 10),

  // Retry transient Anthropic overload/rate-limit failures before failing the
  // daily job. Keeps successful scrape/forum work from being wasted.
  anthropicMaxRetries: parseInt(process.env.ANTHROPIC_MAX_RETRIES || '4', 10),
  anthropicRetryBaseMs: parseInt(process.env.ANTHROPIC_RETRY_BASE_MS || '5000', 10),

};
