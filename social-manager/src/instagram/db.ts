/**
 * Every D1 query for Instagram. Tables are in migrations/0001_init.sql.
 */
import type { Rule, RuleFields } from "../autoreply/rules";
import type { Env } from "../env";
import { DM_SEEN_MS, EVENTS_KEEP_MS, SENT_WINDOW_MS } from "./config";

const now = () => new Date().toISOString();
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

// ── Accounts ────────────────────────────────────────────────────────────────

export interface Account {
  id: string;
  username: string;
  /** System-user token. Never expires; stops working if the connection is removed. */
  token: string;
  connected_at: string;
}

/**
 * Per-isolate cache, so a burst of webhooks costs one query. A disconnect is
 * seen by other isolates within a minute.
 */
const accountCache = new Map<string, { account: Account | null; until: number }>();
const ACCOUNT_CACHE_MS = 60 * 1000;

export async function getAccount(env: Env, id: string): Promise<Account | null> {
  const hit = accountCache.get(id);
  if (hit && hit.until > Date.now()) return hit.account;
  const account = await env.DB.prepare("SELECT * FROM ig_accounts WHERE id = ?").bind(id).first<Account>();
  accountCache.set(id, { account, until: Date.now() + ACCOUNT_CACHE_MS });
  return account;
}

export async function findAccountByUsername(env: Env, username: string): Promise<Account | null> {
  return env.DB.prepare("SELECT * FROM ig_accounts WHERE lower(username) = lower(?)")
    .bind(username.replace(/^@/, ""))
    .first<Account>();
}

export async function listAccounts(env: Env): Promise<Account[]> {
  return (await env.DB.prepare("SELECT * FROM ig_accounts ORDER BY username").all<Account>()).results;
}

/** Insert or, on reconnect, replace the token. Rules and history are kept. */
export async function saveAccount(env: Env, a: Omit<Account, "connected_at">): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ig_accounts (id, username, token, connected_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (id) DO UPDATE SET username = excluded.username, token = excluded.token,
       connected_at = excluded.connected_at`,
  )
    .bind(a.id, a.username, a.token, now())
    .run();
  accountCache.delete(a.id);
}

/** Forgets the token. Rules and activity stay, so reconnecting restores everything. */
export async function deleteAccount(env: Env, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM ig_accounts WHERE id = ?").bind(id).run();
  accountCache.delete(id);
}

// ── Rules ───────────────────────────────────────────────────────────────────

interface RuleRow {
  id: number;
  account_id: string;
  media_id: string | null;
  name: string;
  keywords: string;
  link: string;
  dm: string;
  public_replies: string;
  any_comment: number;
  enabled: number;
  permalink: string | null;
  caption: string | null;
  created_at: string;
  updated_at: string;
}

export interface StoredRule extends Rule {
  permalink: string | null;
  caption: string | null;
  createdAt: string;
  updatedAt: string;
}

function toRule(r: RuleRow): StoredRule {
  return {
    id: r.id,
    mediaId: r.media_id,
    name: r.name,
    keywords: JSON.parse(r.keywords),
    link: r.link,
    dm: r.dm,
    publicReplies: JSON.parse(r.public_replies),
    anyComment: r.any_comment === 1,
    enabled: r.enabled === 1,
    permalink: r.permalink,
    caption: r.caption,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** All of an account's rules, oldest first: that order breaks DM keyword ties. */
export async function listRules(env: Env, accountId: string): Promise<StoredRule[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM ig_rules WHERE account_id = ? ORDER BY created_at, id",
  )
    .bind(accountId)
    .all<RuleRow>();
  return results.map(toRule);
}

export async function getRule(env: Env, accountId: string, id: number): Promise<StoredRule | null> {
  const row = await env.DB.prepare("SELECT * FROM ig_rules WHERE id = ? AND account_id = ?")
    .bind(id, accountId)
    .first<RuleRow>();
  return row ? toRule(row) : null;
}

export async function ruleForMedia(env: Env, accountId: string, mediaId: string): Promise<StoredRule | null> {
  const row = await env.DB.prepare("SELECT * FROM ig_rules WHERE media_id = ? AND account_id = ?")
    .bind(mediaId, accountId)
    .first<RuleRow>();
  return row ? toRule(row) : null;
}

export async function createRule(
  env: Env,
  accountId: string,
  mediaId: string | null,
  rule: RuleFields,
  snapshot: { permalink?: string; caption?: string } = {},
): Promise<number> {
  const t = now();
  const row = await env.DB.prepare(
    `INSERT INTO ig_rules (account_id, media_id, name, keywords, link, dm, public_replies,
       any_comment, enabled, permalink, caption, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12) RETURNING id`,
  )
    .bind(
      accountId,
      mediaId,
      rule.name,
      JSON.stringify(rule.keywords),
      rule.link,
      rule.dm,
      JSON.stringify(rule.publicReplies),
      rule.anyComment ? 1 : 0,
      rule.enabled ? 1 : 0,
      snapshot.permalink ?? null,
      snapshot.caption ?? null,
      t,
    )
    .first<{ id: number }>();
  return row!.id;
}

export async function updateRule(env: Env, accountId: string, id: number, rule: RuleFields): Promise<void> {
  await env.DB.prepare(
    `UPDATE ig_rules SET name = ?1, keywords = ?2, link = ?3, dm = ?4, public_replies = ?5,
       any_comment = ?6, enabled = ?7, updated_at = ?8
     WHERE id = ?9 AND account_id = ?10`,
  )
    .bind(
      rule.name,
      JSON.stringify(rule.keywords),
      rule.link,
      rule.dm,
      JSON.stringify(rule.publicReplies),
      rule.anyComment ? 1 : 0,
      rule.enabled ? 1 : 0,
      now(),
      id,
      accountId,
    )
    .run();
}

export async function deleteRule(env: Env, accountId: string, id: number): Promise<void> {
  await env.DB.prepare("DELETE FROM ig_rules WHERE id = ? AND account_id = ?").bind(id, accountId).run();
}

// ── Dedup ───────────────────────────────────────────────────────────────────

/**
 * Atomically claim "this person gets this Reel's DM". True → go ahead.
 * False → they already got it within the window (or another webhook for
 * them is being handled right now). An expired row is taken over.
 */
export async function claimSent(env: Env, mediaId: string, userId: string, commentId: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `INSERT INTO ig_sent (media_id, user_id, comment_id, at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (media_id, user_id) DO UPDATE SET comment_id = excluded.comment_id, at = excluded.at
     WHERE ig_sent.at < ?5`,
  )
    .bind(mediaId, userId, commentId, now(), ago(SENT_WINDOW_MS))
    .run();
  return res.meta.changes > 0;
}

/** People who already got this Reel's DM within the window. */
export async function sentUserIds(env: Env, mediaId: string): Promise<Set<string>> {
  const { results } = await env.DB.prepare("SELECT user_id FROM ig_sent WHERE media_id = ? AND at >= ?")
    .bind(mediaId, ago(SENT_WINDOW_MS))
    .all<{ user_id: string }>();
  return new Set(results.map((r) => r.user_id));
}

/** Undo a claim whose DM failed, so a later comment from them can try again. */
export async function releaseSent(env: Env, mediaId: string, userId: string, commentId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM ig_sent WHERE media_id = ? AND user_id = ? AND comment_id = ?")
    .bind(mediaId, userId, commentId)
    .run();
}

/** True the first time a DM message id is seen. */
export async function claimDm(env: Env, mid: string): Promise<boolean> {
  const res = await env.DB.prepare("INSERT OR IGNORE INTO ig_dm_seen (mid, at) VALUES (?, ?)").bind(mid, now()).run();
  return res.meta.changes > 0;
}

export async function releaseDm(env: Env, mid: string): Promise<void> {
  await env.DB.prepare("DELETE FROM ig_dm_seen WHERE mid = ?").bind(mid).run();
}

// ── Activity ────────────────────────────────────────────────────────────────

export interface EventInput {
  accountId: string;
  kind: "comment_dm" | "public_reply" | "dm";
  ok: boolean;
  ruleId?: number;
  mediaId?: string;
  username?: string;
  text?: string;
  keyword?: string;
  error?: string;
}

export interface EventRow {
  id: number;
  at: string;
  kind: EventInput["kind"];
  ok: number;
  rule_id: number | null;
  rule_name: string | null;
  media_id: string | null;
  username: string | null;
  text: string | null;
  keyword: string | null;
  error: string | null;
}

export async function recordEvent(env: Env, e: EventInput): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ig_events (at, account_id, kind, ok, rule_id, media_id, username, text, keyword, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      now(),
      e.accountId,
      e.kind,
      e.ok ? 1 : 0,
      e.ruleId ?? null,
      e.mediaId ?? null,
      e.username ?? null,
      e.text ? e.text.slice(0, 200) : null,
      e.keyword ?? null,
      e.error ? e.error.slice(0, 500) : null,
    )
    .run();
}

export async function recentEvents(env: Env, accountId: string, limit = 30): Promise<EventRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT e.*, r.name AS rule_name FROM ig_events e LEFT JOIN ig_rules r ON r.id = e.rule_id
     WHERE e.account_id = ? ORDER BY e.at DESC, e.id DESC LIMIT ?`,
  )
    .bind(accountId, limit)
    .all<EventRow>();
  return results;
}

/** DMs successfully sent per rule (comment private replies + DM replies). */
export async function sentCountsByRule(env: Env, accountId: string): Promise<Map<number, number>> {
  const { results } = await env.DB.prepare(
    `SELECT rule_id, COUNT(*) AS n FROM ig_events
     WHERE account_id = ? AND ok = 1 AND kind IN ('comment_dm', 'dm') AND rule_id IS NOT NULL
     GROUP BY rule_id`,
  )
    .bind(accountId)
    .all<{ rule_id: number; n: number }>();
  return new Map(results.map((r) => [r.rule_id, r.n]));
}

export async function accountStats(env: Env, accountId: string) {
  return env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM ig_rules WHERE account_id = ?1 AND enabled = 1) AS active_rules,
       (SELECT COUNT(*) FROM ig_events WHERE account_id = ?1 AND ok = 1
          AND kind IN ('comment_dm', 'dm') AND at >= ?2) AS dms_7d,
       (SELECT MAX(at) FROM ig_events WHERE account_id = ?1) AS last_activity`,
  )
    .bind(accountId, ago(7 * 24 * 60 * 60 * 1000))
    .first<{ active_rules: number; dms_7d: number; last_activity: string | null }>();
}

// ── Housekeeping (daily cron) ───────────────────────────────────────────────

export async function cleanup(env: Env) {
  const [sent, seen, events] = await env.DB.batch([
    env.DB.prepare("DELETE FROM ig_sent WHERE at < ?").bind(ago(SENT_WINDOW_MS)),
    env.DB.prepare("DELETE FROM ig_dm_seen WHERE at < ?").bind(ago(DM_SEEN_MS)),
    env.DB.prepare("DELETE FROM ig_events WHERE at < ?").bind(ago(EVENTS_KEEP_MS)),
  ]);
  return { sent: sent.meta.changes, dm_seen: seen.meta.changes, events: events.meta.changes };
}
