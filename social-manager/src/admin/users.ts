/**
 * Admin panel users: storage, password hashing and access grants.
 *
 * Passwords are PBKDF2-SHA256 with a random 16-byte salt. The iteration
 * count is stored per user, so it can be raised later without breaking
 * existing logins (rehashed on the next successful login). It is kept
 * moderate because the Workers free plan meters CPU per request.
 */
import { safeEqual } from "../crypto";
import type { Env } from "../env";
import type { Network } from "../networks";

export const PBKDF2_ITERATIONS = 60_000;
export const MIN_PASSWORD = 8;

const hex = (b: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

export async function hashPassword(password: string, saltHex?: string, iterations = PBKDF2_ITERATIONS) {
  const salt = saltHex ?? hex(crypto.getRandomValues(new Uint8Array(16)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations },
    key,
    256,
  );
  return { hash: hex(bits), salt, iterations };
}

export async function verifyPassword(password: string, user: Pick<User, "pw_hash" | "pw_salt" | "pw_iter">) {
  const { hash } = await hashPassword(password, user.pw_salt, user.pw_iter);
  return safeEqual(hash, user.pw_hash);
}

export interface User {
  id: number;
  login: string;
  name: string;
  role: "owner" | "member";
  pw_hash: string;
  pw_salt: string;
  pw_iter: number;
  created_at: string;
  last_login_at: string | null;
}

const now = () => new Date().toISOString();

export const normaliseLogin = (s: string) => s.trim().toLowerCase();

export async function findUserByLogin(env: Env, login: string) {
  return env.DB.prepare("SELECT * FROM users WHERE login = ?").bind(normaliseLogin(login)).first<User>();
}

export async function getUser(env: Env, id: number) {
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<User>();
}

export async function listUsers(env: Env) {
  return (await env.DB.prepare("SELECT * FROM users ORDER BY role DESC, lower(name)").all<User>()).results;
}

export async function createUser(env: Env, u: { login: string; name: string; role: User["role"]; password: string }) {
  const pw = await hashPassword(u.password);
  const row = await env.DB.prepare(
    `INSERT INTO users (login, name, role, pw_hash, pw_salt, pw_iter, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(normaliseLogin(u.login), u.name.trim(), u.role, pw.hash, pw.salt, pw.iterations, now())
    .first<{ id: number }>();
  return row!.id;
}

export async function updateUser(env: Env, id: number, u: { name: string; role: User["role"] }) {
  await env.DB.prepare("UPDATE users SET name = ?, role = ? WHERE id = ?").bind(u.name.trim(), u.role, id).run();
}

/** New salt → every existing session of this user stops verifying. */
export async function setPassword(env: Env, id: number, password: string) {
  const pw = await hashPassword(password);
  await env.DB.prepare("UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iter = ? WHERE id = ?")
    .bind(pw.hash, pw.salt, pw.iterations, id)
    .run();
}

export async function deleteUser(env: Env, id: number) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user_accounts WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id),
  ]);
}

export async function touchLogin(env: Env, id: number) {
  await env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(now(), id).run();
}

// ── Access grants ───────────────────────────────────────────────────────────

export const accessKey = (network: Network, accountId: string) => `${network}:${accountId}`;

export async function grantsFor(env: Env, userId: number): Promise<Set<string>> {
  const { results } = await env.DB.prepare("SELECT network, account_id FROM user_accounts WHERE user_id = ?")
    .bind(userId)
    .all<{ network: Network; account_id: string }>();
  return new Set(results.map((r) => accessKey(r.network, r.account_id)));
}

export async function setGrants(env: Env, userId: number, keys: string[]) {
  const stmts = [env.DB.prepare("DELETE FROM user_accounts WHERE user_id = ?").bind(userId)];
  for (const k of keys) {
    const i = k.indexOf(":");
    if (i < 1) continue;
    stmts.push(
      env.DB.prepare("INSERT OR IGNORE INTO user_accounts (user_id, network, account_id) VALUES (?, ?, ?)").bind(
        userId,
        k.slice(0, i),
        k.slice(i + 1),
      ),
    );
  }
  await env.DB.batch(stmts);
}

// ── Throttling ──────────────────────────────────────────────────────────────

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;

export async function tooManyFailures(env: Env, login: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_failures WHERE login = ? AND at >= ?")
    .bind(normaliseLogin(login), new Date(Date.now() - WINDOW_MS).toISOString())
    .first<{ n: number }>();
  return (row?.n ?? 0) >= MAX_FAILURES;
}

export async function recordFailure(env: Env, login: string) {
  await env.DB.prepare("INSERT INTO login_failures (login, at) VALUES (?, ?)").bind(normaliseLogin(login), now()).run();
}

export async function clearFailures(env: Env, login: string) {
  await env.DB.prepare("DELETE FROM login_failures WHERE login = ?").bind(normaliseLogin(login)).run();
}

export async function trimFailures(env: Env) {
  const res = await env.DB.prepare("DELETE FROM login_failures WHERE at < ?")
    .bind(new Date(Date.now() - WINDOW_MS).toISOString())
    .run();
  return res.meta.changes;
}
