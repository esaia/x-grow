/**
 * Instagram API with Unified Login: everything goes to graph.facebook.com
 * with a system-user token (graph.instagram.com and Instagram user tokens
 * don't work with this setup).
 *
 * Graph API version: checked against Meta's changelog on 2026-11-24, when
 * v27.0 (released 2026-11-04) was the latest. Meta supports each version for
 * roughly two years, so bump this deliberately, not on every release.
 */
export const GRAPH_VERSION = "v27.0";
export const GRAPH_HOST = "https://graph.facebook.com";
/** Login dialog, exactly as the Unified Login get-started guide gives it (unversioned). */
export const OAUTH_DIALOG = "https://www.facebook.com/dialog/oauth";

/** Webhook fields each connected account is subscribed to. */
export const WEBHOOK_FIELDS = ["comments", "messages"];

/** Where Meta sends people back after login. Must be saved in the configuration. */
export const CALLBACK_PATH = "/connect/instagram/callback";

const DAY = 24 * 60 * 60 * 1000;

/** One DM + one public reply per person per Reel within this window. */
export const SENT_WINDOW_MS = 30 * DAY;
/** How long a DM's message id is remembered, so a redelivery is a no-op. */
export const DM_SEEN_MS = 1 * DAY;
/** Activity log retention. */
export const EVENTS_KEEP_MS = 90 * DAY;
