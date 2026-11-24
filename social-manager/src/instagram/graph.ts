/**
 * Thin Graph API client for Instagram with Unified Login (graph.facebook.com,
 * system-user tokens). One client per connected account, since each account
 * has its own token.
 *
 * The token goes in the `Authorization: Bearer` header, never the URL, so it
 * can't end up in a log line. Every call carries `appsecret_proof`
 * (HMAC-SHA256 of the token, keyed with the app secret), so a leaked token is
 * useless without the app secret too. Required when "Require App Secret" is on
 * in the app's advanced settings, and harmless when it's off.
 */
import { hmacHex } from "../crypto";
import type { Env } from "../env";
import { log } from "../log";
import { GRAPH_HOST, GRAPH_VERSION } from "./config";

/**
 * Graph error codes that mean "slow down". Meta's Instagram docs give the
 * limits (750 private replies/hour/account) but not the codes, so these are
 * the Graph API's general throttling codes: 4 app, 17 user, 32 page, 613
 * custom rate, 80002 Instagram per-account limit, 80006 messaging limit.
 */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80002, 80006]);

export class GraphError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    readonly subcode: number | undefined,
    message: string,
    readonly fbtraceId: string | undefined,
  ) {
    super(message);
    this.name = "GraphError";
  }

  get isRateLimit(): boolean {
    return (
      this.status === 429 ||
      (this.code !== undefined && RATE_LIMIT_CODES.has(this.code)) ||
      /rate limit|too many/i.test(this.message)
    );
  }

  /** 10 / 200: the token lacks a permission (e.g. insights). */
  get isPermissionError(): boolean {
    return this.code === 10 || this.code === 200;
  }

  /** 190: the token was revoked (app removed, password changed...). Reconnect. */
  get isAuthError(): boolean {
    return this.code === 190;
  }

  /**
   * The connected account has "Allow access to messages" off, so no tool can
   * DM for it. Every send fails until the owner turns it on.
   */
  get isMessagingDisabled(): boolean {
    return /disabled access to Instagram Direct Messaging/i.test(this.message);
  }

  /** What to tell the person using the panel: the cause and the fix, not Meta's wording. */
  get advice(): string {
    if (this.isMessagingDisabled)
      return 'Direct messages are switched off for tools on this account. In the Instagram app: Settings and activity → Messages and story replies → Message controls → Connected tools → turn on "Allow access to messages".';
    if (this.isAuthError) return "This account's connection expired. Reconnect it in Social Manager.";
    if (this.isRateLimit) return "Instagram's hourly limit was reached. Try again in an hour.";
    return this.message;
  }

  /** Safe to log: no token, includes the trace id Meta support asks for. */
  toLog() {
    return {
      status: this.status,
      code: this.code,
      subcode: this.subcode,
      message: this.message,
      fbtrace_id: this.fbtraceId,
      rate_limited: this.isRateLimit,
    };
  }
}

export interface MediaItem {
  id: string;
  caption?: string;
  /** Video/Reel cover image. Instagram CDN URL, valid for a few days. */
  thumbnail_url?: string;
  /** Image URL for photos (for videos it's the video file). */
  media_url?: string;
  like_count?: number;
  comments_count?: number;
  permalink?: string;
  media_type?: string;
  media_product_type?: string;
  timestamp?: string;
}

type GraphErrorBody = {
  error?: { message?: string; code?: number; error_subcode?: number; fbtrace_id?: string };
};

async function parse<T>(res: Response): Promise<T> {
  const json = (await res.json().catch(() => ({}))) as T & GraphErrorBody;
  if (!res.ok || json.error) {
    const e = json.error ?? {};
    throw new GraphError(res.status, e.code, e.error_subcode, e.message ?? `HTTP ${res.status}`, e.fbtrace_id);
  }
  return json;
}

export function createGraph(env: Env, token: string) {
  const dryRun = env.DRY_RUN === "true";
  let proof: Promise<string> | null = null;

  async function call<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Record<string, string> = {},
    body?: unknown,
  ): Promise<T> {
    proof ??= hmacHex(env.META_APP_SECRET, token);
    const qs = new URLSearchParams({ ...params, appsecret_proof: await proof });
    const res = await fetch(`${GRAPH_HOST}/${GRAPH_VERSION}${path}?${qs}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return parse<T>(res);
  }

  /** POSTs that reach a real person. DRY_RUN logs them instead. */
  async function send<T>(path: string, body: unknown, fake: T): Promise<T> {
    if (dryRun) {
      log.info("instagram.graph.dry_run", { path, body });
      return fake;
    }
    return call<T>("POST", path, {}, body);
  }

  return {
    /**
     * Private reply to a comment. Instagram allows ONE per comment, within 7
     * days of it. Lands in Requests if the commenter doesn't follow you.
     */
    privateReply(igId: string, commentId: string, text: string) {
      return send<{ recipient_id: string; message_id: string }>(
        `/${igId}/messages`,
        { recipient: { comment_id: commentId }, message: { text } },
        { recipient_id: "dry-run", message_id: "dry-run" },
      );
    },

    /** DM someone who messaged you, inside the 24h window their message opened. */
    sendDm(igId: string, recipientId: string, text: string) {
      return send<{ recipient_id: string; message_id: string }>(
        `/${igId}/messages`,
        { recipient: { id: recipientId }, message: { text } },
        { recipient_id: "dry-run", message_id: "dry-run" },
      );
    },

    /** Public reply under a comment. */
    replyToComment(commentId: string, message: string) {
      return send<{ id: string }>(`/${commentId}/replies`, { message }, { id: "dry-run" });
    },

    /**
     * The Instagram accounts this token may act for. With a system-user token
     * `/me` is the system user, not an Instagram account. These `id`s are the
     * ones that arrive as `entry[].id` in webhooks.
     */
    async assignedAccounts() {
      const res = await call<{ data: { id: string; username?: string }[] }>(
        "GET",
        "/me/assigned_instagram_accounts",
        { fields: "id,username", limit: "100" },
      );
      return res.data;
    },

    /** Account still reachable with this token? Used by /admin/instagram/accounts. */
    profile(igId: string) {
      return call<{ id: string; username: string }>("GET", `/${igId}`, { fields: "id,username" });
    },

    /**
     * Turn on webhook delivery for one account. The app-level subscription
     * in the dashboard picks the fields; this picks the accounts. Without it
     * nothing arrives for this account.
     */
    subscribeWebhooks(igId: string, fields: string[]) {
      return call<{ success: boolean }>("POST", `/${igId}/subscribed_apps`, {
        subscribed_fields: fields.join(","),
      });
    },

    unsubscribeWebhooks(igId: string) {
      return call<{ success: boolean }>("DELETE", `/${igId}/subscribed_apps`);
    },

    listMedia(igId: string, after?: string) {
      const params: Record<string, string> = { fields: MEDIA_FIELDS, limit: "24" };
      if (after) params.after = after;
      return call<{ data: MediaItem[]; paging?: { cursors?: { after?: string }; next?: string } }>(
        "GET",
        `/${igId}/media`,
        params,
      );
    },

    media(mediaId: string) {
      return call<MediaItem>("GET", `/${mediaId}`, { fields: MEDIA_FIELDS });
    },

    /** One page of a post's comments, newest first, each with its replies. */
    comments(mediaId: string, after?: string) {
      const params: Record<string, string> = {
        fields: `${COMMENT_FIELDS},replies.limit(50){${COMMENT_FIELDS}}`,
        limit: "50",
      };
      if (after) params.after = after;
      return call<{ data: IgComment[]; paging?: { cursors?: { after?: string }; next?: string } }>(
        "GET",
        `/${mediaId}/comments`,
        params,
      );
    },

    /**
     * Lifetime views of one post. Needs `instagram_manage_insights` in the
     * login configuration; without it Meta answers with a permission error
     * (code 10 or 200), which callers show as "views need a permission".
     */
    async views(mediaId: string): Promise<number | null> {
      const res = await call<{
        data: { name: string; values?: { value: number }[]; total_value?: { value: number } }[];
      }>("GET", `/${mediaId}/insights`, { metric: "views" });
      const m = res.data.find((d) => d.name === "views");
      return m?.total_value?.value ?? m?.values?.[0]?.value ?? null;
    },
  };
}

export interface IgComment {
  id: string;
  text?: string;
  timestamp?: string;
  username?: string;
  from?: { id?: string; username?: string };
  replies?: { data: IgComment[] };
}

const COMMENT_FIELDS = "id,text,timestamp,username,from{id,username}";

const MEDIA_FIELDS =
  "id,caption,permalink,media_type,media_product_type,timestamp,thumbnail_url,media_url,like_count,comments_count";

export type Graph = ReturnType<typeof createGraph>;

/**
 * Login code → system-user access token. Uses the *Meta* app id and secret.
 * The token never expires (the configuration's "Expiration: Never"); it
 * stops working only if the connection is removed.
 */
export async function exchangeCode(env: Env, code: string, redirectUri: string): Promise<string> {
  const qs = new URLSearchParams({
    client_id: env.META_APP_ID,
    client_secret: env.META_APP_SECRET,
    redirect_uri: redirectUri,
    code,
  });
  const res = await fetch(`${GRAPH_HOST}/${GRAPH_VERSION}/oauth/access_token?${qs}`);
  const json = await parse<{ access_token?: string }>(res);
  if (!json.access_token) throw new GraphError(res.status, undefined, undefined, "No access_token in response", undefined);
  return json.access_token;
}
