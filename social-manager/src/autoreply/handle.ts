/**
 * What happens when a comment or DM arrives, for every network. Each
 * network's webhook parser normalises its payload into IncomingComment /
 * IncomingDm and calls these.
 */
import type { Env } from "../env";
import { log, preview } from "../log";
import { GraphError } from "../meta";
import { NETWORKS, type Client } from "../networks";
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
import { matchComment, matchDm, pickPublicReply, renderDm } from "./rules";

export interface IncomingComment {
  commentId: string;
  /** The Reel / post the comment is on. */
  mediaId: string;
  /** Commenter id. Missing on some Facebook comments; dedup then uses the comment. */
  userId?: string;
  username?: string;
  text: string;
}

export interface IncomingDm {
  mid: string;
  senderId: string;
  text?: string;
  /** Sent by the account itself (echo / test message). */
  own: boolean;
  /** Deleted / unsupported message types. */
  skip: boolean;
}

/** Look up the account an event is for; null (and a log line) if it isn't connected. */
export async function accountFor(env: Env, network: Account["network"], entryId: string | undefined) {
  const account = entryId ? await getAccount(env, network, entryId) : null;
  if (!account) {
    // Meta's dashboard "Test" button lands here too: its sample ids aren't ours.
    log.warn(`${network}.webhook.unknown_account`, { entry_id: entryId, hint: "Connect it in the admin panel." });
  }
  return account;
}

/** One bad event mustn't stop the rest of the batch. */
export async function guard(kind: string, account: Account, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    log.error(`${account.network}.${kind}.crashed`, {
      account: account.username,
      error: err instanceof GraphError ? err.toLog() : String(err),
    });
  }
}

function errorFields(err: unknown) {
  return err instanceof GraphError ? { error: err.toLog(), advice: err.advice } : { error: String(err) };
}

/** For the panel's activity list: the cause and the fix, in plain words. */
export function errorText(err: unknown): string {
  return err instanceof GraphError ? err.advice : String(err);
}

export async function handleComment(env: Env, account: Account, c: IncomingComment, client?: Client) {
  const ev = `${account.network}.comment`;
  const userId = c.userId ?? `comment:${c.commentId}`;
  const ctx = {
    account: account.username,
    comment_id: c.commentId,
    media_id: c.mediaId,
    user_id: c.userId,
    username: c.username,
    text: preview(c.text),
  };

  // Our own public replies come back as comment webhooks. Answering them would loop.
  if (c.userId === account.id || c.username?.toLowerCase() === account.username.toLowerCase()) {
    log.info(`${ev}.skip_own`, ctx);
    return;
  }

  const rule = await ruleForMedia(env, account, c.mediaId);
  if (!rule) {
    log.info(`${ev}.unknown_media`, ctx);
    return;
  }
  if (!rule.enabled) {
    log.info(`${ev}.rule_disabled`, { ...ctx, rule: rule.name });
    return;
  }
  // Backstop for the loop guard above, in case `from` ever doesn't match.
  if (rule.publicReplies.includes(c.text)) {
    log.info(`${ev}.skip_own_reply_text`, ctx);
    return;
  }

  const hit = matchComment(rule, c.text);
  if (!hit) {
    log.info(`${ev}.no_match`, { ...ctx, rule: rule.name });
    return;
  }

  // Atomic claim: of two simultaneous comments from one person, one wins.
  if (!(await claimSent(env, c.mediaId, userId, c.commentId))) {
    log.info(`${ev}.already_sent`, { ...ctx, rule: rule.name });
    return;
  }

  const api = client ?? NETWORKS[account.network].client(env, account);
  const base = {
    network: account.network,
    accountId: account.id,
    ruleId: rule.id,
    mediaId: c.mediaId,
    username: c.username,
    text: c.text,
    keyword: hit.keyword,
  };
  const matchInfo = { rule: rule.name, keyword: hit.keyword, matched: hit.matched, distance: hit.distance };

  try {
    await api.privateReply(c.commentId, renderDm(rule));
    log.info(`${ev}.dm_sent`, { ...ctx, ...matchInfo });
    await recordEvent(env, { ...base, kind: "comment_dm", ok: true });
  } catch (err) {
    // Release the claim so the person can comment again later and get it.
    await releaseSent(env, c.mediaId, userId, c.commentId);
    const rate = err instanceof GraphError && err.isRateLimit;
    log[rate ? "warn" : "error"](rate ? `${ev}.rate_limited_skipped` : `${ev}.dm_failed`, {
      ...ctx,
      ...matchInfo,
      ...errorFields(err),
    });
    await recordEvent(env, { ...base, kind: "comment_dm", ok: false, error: errorText(err) });
    return; // no "Sent!" reply for a DM that didn't go out
  }

  const reply = pickPublicReply(rule);
  if (!reply) return;
  try {
    await api.replyToComment(c.commentId, reply);
    log.info(`${ev}.public_reply_sent`, { ...ctx, rule: rule.name });
    await recordEvent(env, { ...base, kind: "public_reply", ok: true, text: reply, username: undefined });
  } catch (err) {
    // The DM went out, which is what matters. Keep the claim.
    log.error(`${ev}.public_reply_failed`, { ...ctx, ...errorFields(err) });
    await recordEvent(env, { ...base, kind: "public_reply", ok: false, text: reply, error: errorText(err) });
  }
}

export async function handleDm(env: Env, account: Account, m: IncomingDm) {
  const ev = `${account.network}.dm`;
  const ctx = { account: account.username, sender_id: m.senderId, mid: m.mid, text: preview(m.text) };

  if (m.own || m.senderId === account.id) {
    log.info(`${ev}.skip_own`, ctx);
    return;
  }
  if (m.skip || !m.text) {
    log.info(`${ev}.skip_no_text`, ctx);
    return;
  }

  const rules = (await listRules(env, account)).filter((r) => r.enabled);
  const found = matchDm(rules, m.text);
  if (!found) {
    log.info(`${ev}.no_match`, ctx);
    return;
  }
  if (!(await claimDm(env, m.mid))) {
    log.info(`${ev}.duplicate_delivery`, ctx);
    return;
  }

  const { rule, hit } = found;
  const base = {
    network: account.network,
    accountId: account.id,
    ruleId: rule.id,
    text: m.text,
    keyword: hit.keyword,
    kind: "dm" as const,
  };
  const matchInfo = { rule: rule.name, keyword: hit.keyword, matched: hit.matched, distance: hit.distance };
  try {
    await NETWORKS[account.network].client(env, account).sendDm(m.senderId, renderDm(rule));
    log.info(`${ev}.sent`, { ...ctx, ...matchInfo });
    await recordEvent(env, { ...base, ok: true });
  } catch (err) {
    await releaseDm(env, m.mid);
    const rate = err instanceof GraphError && err.isRateLimit;
    log[rate ? "warn" : "error"](rate ? `${ev}.rate_limited_skipped` : `${ev}.failed`, {
      ...ctx,
      ...matchInfo,
      ...errorFields(err),
    });
    await recordEvent(env, { ...base, ok: false, error: errorText(err) });
  }
}
