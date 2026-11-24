/**
 * Webhook handling: GET verification, POST signature check, and the comment
 * and DM handlers that run after the 200 has already gone back to Meta.
 *
 * Every entry names the account it is for (`entry.id`). That id selects the
 * account's token and its rules from D1.
 */
import { matchComment, matchDm, pickPublicReply, renderDm } from "../autoreply/rules";
import type { Env } from "../env";
import { log, preview } from "../log";
import {
  claimDm,
  claimSent,
  getAccount,
  listRules,
  recordEvent,
  releaseDm,
  releaseSent,
  ruleForMedia,
  type Account,
} from "./db";
import { GraphError, createGraph, type Graph } from "./graph";
import { verifySignature } from "./signature";

// ── Payload shapes (only the fields we read) ────────────────────────────────

interface CommentValue {
  /** Comment id. Unified Login payloads use `comment_id`; Instagram Login used `id`. */
  comment_id?: string;
  id?: string;
  text?: string;
  from?: { id?: string; username?: string };
  media?: { id?: string; media_product_type?: string };
  parent_id?: string;
}

interface MessagingEvent {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    is_self?: boolean;
    is_deleted?: boolean;
    is_unsupported?: boolean;
  };
}

interface Entry {
  /** The Instagram professional account this event is for. */
  id?: string;
  time?: number;
  changes?: { field?: string; value?: CommentValue }[];
  messaging?: MessagingEvent[];
}

interface Payload {
  object?: string;
  entry?: Entry[];
}

/** What a handler needs to act as one account. */
interface Ctx {
  env: Env;
  account: Account;
  graph: Graph;
}

// ── GET /webhooks/instagram ─────────────────────────────────────────────────

/** Meta's one-time subscription check when you save the callback URL. */
export function verifySubscription(url: URL, env: Env): Response {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === env.IG_VERIFY_TOKEN && challenge) {
    log.info("instagram.webhook.verified");
    return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  log.warn("instagram.webhook.verify_failed", { mode, token_matches: token === env.IG_VERIFY_TOKEN });
  return new Response("Forbidden", { status: 403 });
}

// ── POST /webhooks/instagram ────────────────────────────────────────────────

/**
 * Answers 200 as soon as the signature checks out and does the work in
 * `ctx.waitUntil`. A slow answer makes Meta retry, and a retry is a second
 * DM attempt.
 */
export async function receiveWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const raw = await request.arrayBuffer();
  const which = await verifySignature(raw, request.headers.get("X-Hub-Signature-256"), [
    { name: "META_APP_SECRET", value: env.META_APP_SECRET },
    { name: "IG_APP_SECRET_ALT", value: env.IG_APP_SECRET_ALT },
  ]);
  if (!which) {
    log.warn("instagram.signature.invalid", {
      has_header: request.headers.has("X-Hub-Signature-256"),
      hint: "Webhooks are signed with the Meta app secret (App settings > Basic). See README.",
    });
    return new Response("Invalid signature", { status: 401 });
  }
  if (which !== "META_APP_SECRET") log.info("instagram.signature.ok", { which });

  let payload: Payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    log.warn("instagram.webhook.bad_json");
    return new Response("Bad JSON", { status: 400 });
  }

  ctx.waitUntil(processPayload(payload, env));
  return new Response("EVENT_RECEIVED", { status: 200 });
}

export async function processPayload(payload: Payload, env: Env): Promise<void> {
  if (payload.object !== "instagram") {
    log.info("instagram.webhook.ignored", { object: payload.object });
    return;
  }

  // Sequential on purpose: Meta batches events, and firing them all at once
  // burns through the per-hour limit in bursts.
  for (const entry of payload.entry ?? []) {
    const account = entry.id ? await getAccount(env, entry.id) : null;
    if (!account) {
      // Meta's dashboard "Test" button lands here too: its sample ids aren't ours.
      log.warn("instagram.webhook.unknown_account", {
        entry_id: entry.id,
        hint: "Connect this account in the admin panel.",
      });
      continue;
    }

    const ctx: Ctx = { env, account, graph: createGraph(env, account.token) };

    for (const change of entry.changes ?? []) {
      if (change.field !== "comments" || !change.value) {
        log.info("instagram.webhook.change_ignored", { account: account.username, field: change.field });
        continue;
      }
      await guard("instagram.comment", account, () => handleComment(change.value!, ctx));
    }

    for (const event of entry.messaging ?? []) {
      await guard("instagram.dm", account, () => handleMessage(event, ctx));
    }
  }
}

/** One bad event mustn't stop the rest of the batch. */
async function guard(kind: string, account: Account, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    log.error(`${kind}.crashed`, {
      account: account.username,
      error: err instanceof GraphError ? err.toLog() : String(err),
    });
  }
}

function errorFields(err: unknown) {
  if (!(err instanceof GraphError)) return { error: String(err) };
  return {
    error: err.toLog(),
    ...(err.isAuthError ? { hint: "Token revoked: reconnect this account in the admin panel." } : {}),
  };
}

/** For the panel's activity list: the cause and the fix, in plain words. */
function errorText(err: unknown): string {
  return err instanceof GraphError ? err.advice : String(err);
}

// ── Comments ────────────────────────────────────────────────────────────────

async function handleComment(value: CommentValue, { env, account, graph }: Ctx) {
  const commentId = value.comment_id ?? value.id;
  const userId = value.from?.id;
  const username = value.from?.username;
  const mediaId = value.media?.id;
  const text = value.text ?? "";
  const ctx = {
    account: account.username,
    comment_id: commentId,
    media_id: mediaId,
    user_id: userId,
    username,
    text: preview(text),
  };

  if (!commentId || !userId || !mediaId) {
    log.warn("instagram.comment.incomplete", { ...ctx, value });
    return;
  }

  // Our own public replies come back as comment webhooks. Answering them
  // would loop.
  if (userId === account.id || username?.toLowerCase() === account.username.toLowerCase()) {
    log.info("instagram.comment.skip_own", ctx);
    return;
  }

  const rule = await ruleForMedia(env, account.id, mediaId);
  if (!rule) {
    log.info("instagram.comment.unknown_media", ctx);
    return;
  }
  if (!rule.enabled) {
    log.info("instagram.comment.rule_disabled", { ...ctx, rule: rule.name });
    return;
  }

  // Backstop for the loop guard above, in case `from` ever doesn't match.
  if (rule.publicReplies.includes(text)) {
    log.info("instagram.comment.skip_own_reply_text", ctx);
    return;
  }

  const hit = matchComment(rule, text);
  if (!hit) {
    log.info("instagram.comment.no_match", { ...ctx, rule: rule.name });
    return;
  }

  // Atomic claim: of two simultaneous comments from one person, one wins.
  if (!(await claimSent(env, mediaId, userId, commentId))) {
    log.info("instagram.comment.already_sent", { ...ctx, rule: rule.name });
    return;
  }

  const base = { accountId: account.id, ruleId: rule.id, mediaId, username, text, keyword: hit.keyword };
  const matchInfo = { rule: rule.name, keyword: hit.keyword, matched: hit.matched, distance: hit.distance };

  try {
    const res = await graph.privateReply(account.id, commentId, renderDm(rule));
    log.info("instagram.comment.dm_sent", { ...ctx, ...matchInfo, message_id: res.message_id });
    await recordEvent(env, { ...base, kind: "comment_dm", ok: true });
  } catch (err) {
    // Release the claim so the person can comment again later and get it.
    await releaseSent(env, mediaId, userId, commentId);
    const level = err instanceof GraphError && err.isRateLimit ? "warn" : "error";
    const event = level === "warn" ? "instagram.comment.rate_limited_skipped" : "instagram.comment.dm_failed";
    log[level](event, { ...ctx, ...matchInfo, ...errorFields(err) });
    await recordEvent(env, { ...base, kind: "comment_dm", ok: false, error: errorText(err) });
    return; // no "Sent!" reply for a DM that didn't go out
  }

  const reply = pickPublicReply(rule);
  if (!reply) return;
  try {
    const res = await graph.replyToComment(commentId, reply);
    log.info("instagram.comment.public_reply_sent", { ...ctx, rule: rule.name, reply_id: res.id });
    await recordEvent(env, { ...base, kind: "public_reply", ok: true, text: reply, username: undefined });
  } catch (err) {
    // The DM went out, which is what matters. Keep the claim.
    log.error("instagram.comment.public_reply_failed", { ...ctx, ...errorFields(err) });
    await recordEvent(env, { ...base, kind: "public_reply", ok: false, text: reply, error: errorText(err) });
  }
}

// ── DMs ─────────────────────────────────────────────────────────────────────

async function handleMessage(event: MessagingEvent, { env, account, graph }: Ctx) {
  const msg = event.message;
  const senderId = event.sender?.id;
  const ctx = { account: account.username, sender_id: senderId, mid: msg?.mid, text: preview(msg?.text) };

  if (!msg) {
    // Reads, reactions, postbacks... nothing to answer.
    log.info("instagram.dm.non_message_event", { account: account.username, keys: Object.keys(event) });
    return;
  }
  if (msg.is_echo || msg.is_self || senderId === account.id) {
    log.info("instagram.dm.skip_own", ctx);
    return;
  }
  if (msg.is_deleted || msg.is_unsupported || !msg.text || !senderId || !msg.mid) {
    log.info("instagram.dm.skip_no_text", ctx);
    return;
  }

  const rules = (await listRules(env, account.id)).filter((r) => r.enabled);
  const found = matchDm(rules, msg.text);
  if (!found) {
    log.info("instagram.dm.no_match", ctx);
    return;
  }

  if (!(await claimDm(env, msg.mid))) {
    log.info("instagram.dm.duplicate_delivery", ctx);
    return;
  }

  const { rule, hit } = found;
  const base = { accountId: account.id, ruleId: rule.id, text: msg.text, keyword: hit.keyword, kind: "dm" as const };
  const matchInfo = { rule: rule.name, keyword: hit.keyword, matched: hit.matched, distance: hit.distance };
  try {
    const res = await graph.sendDm(account.id, senderId, renderDm(rule));
    log.info("instagram.dm.sent", { ...ctx, ...matchInfo, message_id: res.message_id });
    await recordEvent(env, { ...base, ok: true });
  } catch (err) {
    await releaseDm(env, msg.mid);
    const level = err instanceof GraphError && err.isRateLimit ? "warn" : "error";
    const event = level === "warn" ? "instagram.dm.rate_limited_skipped" : "instagram.dm.failed";
    log[level](event, { ...ctx, ...matchInfo, ...errorFields(err) });
    await recordEvent(env, { ...base, ok: false, error: errorText(err) });
  }
}
