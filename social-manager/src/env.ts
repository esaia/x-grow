/**
 * Bindings, vars and secrets. Public values (app id, config id) are [vars]
 * in wrangler.toml. Secrets are set with `wrangler secret put <NAME>` (or
 * `.dev.vars` locally) and never appear in wrangler.toml or the code.
 * Network-specific names carry the network's prefix.
 */
export interface Env {
  /** D1 database, shared by every network; tables are prefixed `ig_` etc. */
  DB: D1Database;

  // ── Shared ────────────────────────────────────────────────────────────────

  /**
   * Admin panel password, and `Authorization: Bearer` key for /admin/api/*.
   * Changing it logs every admin session out.
   */
  ADMIN_KEY?: string;
  /** "true" → log API writes instead of sending them (local testing). */
  DRY_RUN?: string;

  // ── Meta app (shared by every Meta network: Instagram today) ──────────────

  /** App ID from the top of the Meta app dashboard. Public; a [var]. */
  META_APP_ID: string;
  /**
   * App secret from App settings > Basic. Exchanges the login code for a
   * token, signs `appsecret_proof`, and (Meta's docs imply) signs webhooks.
   */
  META_APP_SECRET: string;

  // ── Facebook Pages ────────────────────────────────────────────────────────

  /**
   * Configuration ID of the Facebook Login for Business configuration with
   * Page assets (a separate configuration from Instagram's). Public; a [var].
   */
  FB_LOGIN_CONFIG_ID?: string;

  // ── Instagram ─────────────────────────────────────────────────────────────

  /**
   * Configuration ID of the "Instagram API with Unified Login" login
   * configuration (Use cases > Instagram > API setup with Unified login).
   * Public; a [var].
   */
  IG_LOGIN_CONFIG_ID: string;
  /**
   * Any random string; you type the same value into the Meta webhook form.
   * One value serves every network's webhook (Instagram and Facebook Pages).
   */
  IG_VERIFY_TOKEN: string;
  /**
   * Optional second secret tried when META_APP_SECRET doesn't verify a
   * webhook, e.g. an "Instagram app secret" if the dashboard shows one. The
   * log line `instagram.signature.ok` says which matched; delete if unused.
   */
  IG_APP_SECRET_ALT?: string;
}
