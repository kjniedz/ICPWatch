// Worker bindings and configuration. Secrets are optional: a channel without its secret is
// reported as "not configured" instead of failing.
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SITE_URL: string;
  IC_HOST: string;
  /** Shared secret for /admin endpoints (manual runs, simulated incidents). */
  ADMIN_TOKEN?: string;
  /** Resend-compatible API key for transactional email. */
  RESEND_API_KEY?: string;
  /** From address for alert email, e.g. "ICPWatch Lifeline <alerts@icpwatch.com>". */
  EMAIL_FROM?: string;
  TELEGRAM_BOT_TOKEN?: string;
}
