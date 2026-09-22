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
  /** CoinGecko demo key for token links. Without it the keyless tier is shared with every other Worker and is usually exhausted. */
  COINGECKO_API_KEY?: string;
  /** Life support spends real ICP. It only goes live when this is exactly "true" AND an identity is set AND the DB kill switch is released. */
  LIFE_SUPPORT_ENABLED?: string;
  /** 32 byte Ed25519 seed (hex or base64) of the funding identity. */
  LIFE_SUPPORT_IDENTITY?: string;
  LIFE_SUPPORT_ALERT_WEBHOOK?: string;
}
