/**
 * Meta Graph API plumbing shared by every Meta network (Instagram with
 * Unified Login, Facebook Pages): both live on graph.facebook.com.
 *
 * The token goes in the `Authorization: Bearer` header, never the URL, so it
 * can't end up in a log line. Every call carries `appsecret_proof`
 * (HMAC-SHA256 of the token keyed with the app secret), so a leaked token is
 * useless without the app secret.
 *
 * Graph API version: checked against Meta's changelog on 2026-11-24, when
 * v27.0 (released 2026-11-04) was the latest. Bump deliberately.
 */
import { hmacHex } from "./crypto";
import type { Env } from "./env";
import { log } from "./log";

export const GRAPH_VERSION = "v27.0";
export const GRAPH_HOST = "https://graph.facebook.com";
/** Login dialog, exactly as Meta's Unified Login / FLfB guides give it (unversioned). */
export const OAUTH_DIALOG = "https://www.facebook.com/dialog/oauth";

/**
 * Graph error codes that mean "slow down". Meta's docs give limits, not
 * codes, so these are the Graph API's general throttling codes: 4 app,
 * 17 user, 32 page, 613 custom rate, 80002 Instagram, 80006 messaging.
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
   * The connected Instagram account has "Allow access to messages" off, so
   * no tool can DM for it. Every send fails until the owner turns it on.
   */
  get isMessagingDisabled(): boolean {
    return /disabled access to Instagram Direct Messaging/i.test(this.message);
  }

  /** What to tell the person using the panel: the cause and the fix, not Meta's wording. */
  get advice(): string {
    if (this.isMessagingDisabled)
      return 'Direct messages are switched off for tools on this account. In the Instagram app: Settings and activity → Messages and story replies → Message controls → Connected tools → turn on "Allow access to messages".';
    if (this.isAuthError) return "This account's connection expired. Reconnect it in Social Manager.";
    if (this.isRateLimit) return "Meta's hourly limit was reached. Try again in an hour.";
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

export type GraphCall = <T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  params?: Record<string, string>,
  body?: unknown,
) => Promise<T>;

/** `call` for reads, `send` for writes that reach a person (DRY_RUN logs them instead). */
export function graph(env: Env, token: string) {
  let proof: Promise<string> | null = null;

  const call: GraphCall = async (method, path, params = {}, body) => {
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
    return parse(res);
  };

  async function send<T>(path: string, body: unknown, fake: T): Promise<T> {
    if (env.DRY_RUN === "true") {
      log.info("graph.dry_run", { path, body });
      return fake;
    }
    return call<T>("POST", path, {}, body);
  }

  return { call, send };
}

/**
 * Login code → access token, with the Meta app id and secret. For a
 * "System-user access token / Expiration: Never" configuration the token
 * never expires; it stops working only if the connection is removed.
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
