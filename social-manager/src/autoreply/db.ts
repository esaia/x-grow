/**
 * Every D1 query for auto-replies, for every network. Tables:
 * migrations/0001_init.sql, generalised by 0002_networks.sql.
 */
import type { Env } from "../env";
import type { Network } from "../networks";
import type { Rule, RuleFields } from "./rules";

const DAY = 24 * 60 * 60 * 1000;
/** One DM + one public reply per person per Reel/post within this window. */
export const SENT_WINDOW_MS = 30 * DAY;
/** How long a DM's message id is remembered, so a redelivery is a no-op. */
const DM_SEEN_MS = 1 * DAY;
/** Activity log retention. */
const EVENTS_KEEP_MS = 90 * DAY;

const now = () => new Date().toISOString();
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

// ── Accounts ────────────────────────────────────────────────────────────────

export interface Account {
  network: Network;
  /** Instagram account id / Facebook Page id (= webhook entry.id). */
  id: string;
  /** Instagram @handle / Facebook Page name. */
  username: string;
  /** Never expires; stops working if the connection is removed. Never rendered. */
  token: string;
  connected_at: string;
}

/**
 * Per-isolate cache, so a burst of webhooks costs one query. A disconnect is
 * seen by other isolates within a minute.
 */
const accountCache = new Map<string, { account: Account | null; until: number }>();
const ACCOUNT_CACHE_MS = 60 * 1000;

export async function getAccount(env: Env, network: Network, id: string): Promise<Account | null> {
  const key = `${network}:${id}`;
  const hit = accountCache.get(key);
  if (hit && hit.until > Date.now()) return hit.account;
  const account = await env.DB.prepare("SELECT * FROM accounts WHERE network = ? AND id = ?")
    .bind(network, id)
    .first<Account>();
  accountCache.set(key, { account, until: Date.now() + ACCOUNT_CACHE_MS });
  return account;
}

export async function listAccounts(env: Env, network: Network): Promise<Account[]> {
  return (
    await env.DB.prepare("SELECT * FROM accounts WHERE network = ? ORDER BY lower(username)").bind(network).all<Account>()
  ).results;
}

/** Insert or, on reconnect, replace the token. Rules and history are kept. */
export async function saveAccount(env: Env, a: Omit<Account, "connected_at">): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO accounts (network, id, username, token, connected_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (network, id) DO UPDATE SET username = excluded.username, token = excluded.token,
       connected_at = excluded.connected_at`,
  )
    .bind(a.network, a.id, a.username, a.token, now())
    .run();
  accountCache.delete(`${a.network}:${a.id}`);
}

/** Forgets the token. Rules and activity stay, so reconnecting restores everything. */
export async function deleteAccount(env: Env, network: Network, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM accounts WHERE network = ? AND id = ?").bind(network, id).run();
  accountCache.delete(`${network}:${id}`);
}

// ── Rules ───────────────────────────────────────────────────────────────────

interface RuleRow {
  id: number;
  network: Network;
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
  updated_by: string | null;
}

export interface StoredRule extends Rule {
  permalink: string | null;
  caption: string | null;
  createdAt: string;
  updatedAt: string;
  /** Name of the person who last saved it, if known. */
  updatedBy: string | null;
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
    updatedBy: r.updated_by,
  };
}

/** One account's rules, oldest first: that order breaks DM keyword ties. */
export async function listRules(env: Env, a: Pick<Account, "network" | "id">): Promise<StoredRule[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM rules WHERE network = ? AND account_id = ? ORDER BY created_at, id",
  )
    .bind(a.network, a.id)
    .all<RuleRow>();
  return results.map(toRule);
}

export async function getRule(env: Env, a: Pick<Account, "network" | "id">, id: number): Promise<StoredRule | null> {
  const row = await env.DB.prepare("SELECT * FROM rules WHERE id = ? AND network = ? AND account_id = ?")
    .bind(id, a.network, a.id)
    .first<RuleRow>();
  return row ? toRule(row) : null;
}

export async function ruleForMedia(
  env: Env,
  a: Pick<Account, "network" | "id">,
  mediaId: string,
): Promise<StoredRule | null> {
  const row = await env.DB.prepare("SELECT * FROM rules WHERE network = ? AND account_id = ? AND media_id = ?")
    .bind(a.network, a.id, mediaId)
    .first<RuleRow>();
  return row ? toRule(row) : null;
}

export async function createRule(
  env: Env,
  a: Pick<Account, "network" | "id">,
  mediaId: string | null,
  rule: RuleFields,
  snapshot: { permalink?: string; caption?: string } = {},
  by: string | null = null,
): Promise<number> {
  const t = now();
  const row = await env.DB.prepare(
    `INSERT INTO rules (network, account_id, media_id, name, keywords, link, dm, public_replies,
       any_comment, enabled, permalink, caption, created_at, updated_at, updated_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13, ?14) RETURNING id`,
  )
    .bind(
      a.network,
      a.id,
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
      by,
    )
    .first<{ id: number }>();
  return row!.id;
}

export async function updateRule(
  env: Env,
  a: Pick<Account, "network" | "id">,
  id: number,
  rule: RuleFields,
  by: string | null = null,
) {
  await env.DB.prepare(
    `UPDATE rules SET name = ?1, keywords = ?2, link = ?3, dm = ?4, public_replies = ?5,
       any_comment = ?6, enabled = ?7, updated_at = ?8, updated_by = ?12
     WHERE id = ?9 AND network = ?10 AND account_id = ?11`,
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
      a.network,
      a.id,
      by,
    )
    .run();
}

export async function deleteRule(env: Env, a: Pick<Account, "network" | "id">, id: number) {
  await env.DB.prepare("DELETE FROM rules WHERE id = ? AND network = ? AND account_id = ?")
    .bind(id, a.network, a.id)
    .run();
}

// ── Dedup (ids are unique across networks) ──────────────────────────────────

/**
 * Atomically claim "this person gets this post's DM". True → go ahead.
 * False → they already got it within the window (or another webhook for
 * them is being handled right now). An expired row is taken over.
 */
export async function claimSent(env: Env, mediaId: string, userId: string, commentId: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `INSERT INTO sent (media_id, user_id, comment_id, at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (media_id, user_id) DO UPDATE SET comment_id = excluded.comment_id, at = excluded.at
     WHERE sent.at < ?5`,
  )
    .bind(mediaId, userId, commentId, now(), ago(SENT_WINDOW_MS))
    .run();
  return res.meta.changes > 0;
}

/** People who already got this post's DM within the window. */
export async function sentUserIds(env: Env, mediaId: string): Promise<Set<string>> {
  const { results } = await env.DB.prepare("SELECT user_id FROM sent WHERE media_id = ? AND at >= ?")
    .bind(mediaId, ago(SENT_WINDOW_MS))
    .all<{ user_id: string }>();
  return new Set(results.map((r) => r.user_id));
}

/** Undo a claim whose DM failed, so a later comment from them can try again. */
export async function releaseSent(env: Env, mediaId: string, userId: string, commentId: string) {
  await env.DB.prepare("DELETE FROM sent WHERE media_id = ? AND user_id = ? AND comment_id = ?")
    .bind(mediaId, userId, commentId)
    .run();
}

/** True the first time a DM message id is seen. */
export async function claimDm(env: Env, mid: string): Promise<boolean> {
  const res = await env.DB.prepare("INSERT OR IGNORE INTO dm_seen (mid, at) VALUES (?, ?)").bind(mid, now()).run();
  return res.meta.changes > 0;
}

export async function releaseDm(env: Env, mid: string) {
  await env.DB.prepare("DELETE FROM dm_seen WHERE mid = ?").bind(mid).run();
}

// ── Activity ────────────────────────────────────────────────────────────────

export interface EventInput {
  network: Network;
  accountId: string;
  kind: "comment_dm" | "public_reply" | "dm";
  ok: boolean;
  ruleId?: number;
  mediaId?: string;
  username?: string;
  text?: string;
  keyword?: string;
  error?: string;
  /** The person who triggered it by hand (past comments); empty for automatic replies. */
  actor?: string;
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
  actor: string | null;
}

export async function recordEvent(env: Env, e: EventInput) {
  await env.DB.prepare(
    `INSERT INTO events (at, network, account_id, kind, ok, rule_id, media_id, username, text, keyword, error, actor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      now(),
      e.network,
      e.accountId,
      e.kind,
      e.ok ? 1 : 0,
      e.ruleId ?? null,
      e.mediaId ?? null,
      e.username ?? null,
      e.text ? e.text.slice(0, 200) : null,
      e.keyword ?? null,
      e.error ? e.error.slice(0, 500) : null,
      e.actor ?? null,
    )
    .run();
}

export async function recentEvents(env: Env, a: Pick<Account, "network" | "id">, limit = 30): Promise<EventRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT e.*, r.name AS rule_name FROM events e LEFT JOIN rules r ON r.id = e.rule_id
     WHERE e.network = ? AND e.account_id = ? ORDER BY e.at DESC, e.id DESC LIMIT ?`,
  )
    .bind(a.network, a.id, limit)
    .all<EventRow>();
  return results;
}

/** DMs successfully sent per rule (comment private replies + DM replies). */
export async function sentCountsByRule(env: Env, a: Pick<Account, "network" | "id">): Promise<Map<number, number>> {
  const { results } = await env.DB.prepare(
    `SELECT rule_id, COUNT(*) AS n FROM events
     WHERE network = ? AND account_id = ? AND ok = 1 AND kind IN ('comment_dm', 'dm') AND rule_id IS NOT NULL
     GROUP BY rule_id`,
  )
    .bind(a.network, a.id)
    .all<{ rule_id: number; n: number }>();
  return new Map(results.map((r) => [r.rule_id, r.n]));
}

export async function accountStats(env: Env, a: Pick<Account, "network" | "id">) {
  return env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM rules WHERE network = ?1 AND account_id = ?2 AND enabled = 1) AS active_rules,
       (SELECT COUNT(*) FROM events WHERE network = ?1 AND account_id = ?2 AND ok = 1
          AND kind IN ('comment_dm', 'dm') AND at >= ?3) AS dms_7d,
       (SELECT MAX(at) FROM events WHERE network = ?1 AND account_id = ?2) AS last_activity`,
  )
    .bind(a.network, a.id, ago(7 * DAY))
    .first<{ active_rules: number; dms_7d: number; last_activity: string | null }>();
}

// ── Housekeeping (daily cron) ───────────────────────────────────────────────

export async function cleanup(env: Env) {
  const [sent, seen, events] = await env.DB.batch([
    env.DB.prepare("DELETE FROM sent WHERE at < ?").bind(ago(SENT_WINDOW_MS)),
    env.DB.prepare("DELETE FROM dm_seen WHERE at < ?").bind(ago(DM_SEEN_MS)),
    env.DB.prepare("DELETE FROM events WHERE at < ?").bind(ago(EVENTS_KEEP_MS)),
  ]);
  return { sent: sent.meta.changes, dm_seen: seen.meta.changes, events: events.meta.changes };
}
