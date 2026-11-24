/**
 * Admin panel login and sessions.
 *
 * People log in with email + password (users table). The ADMIN_KEY secret
 * also logs in, as an owner with no email: leave the email empty. It is the
 * way back in if every password is lost, and the `Authorization: Bearer`
 * key for /admin/api/*.
 *
 * Session cookie, 30 days, nothing stored server-side:
 *
 *   sm_admin = <user id>.<expiry ms>.<HMAC-SHA256(ADMIN_KEY, "admin-session:<id>:<expiry>:<stamp>")>
 *
 * `stamp` is the user's password salt ("key" for the admin key), so changing
 * someone's password, or deleting them, ends their sessions at once; changing
 * ADMIN_KEY ends everyone's. HttpOnly + Secure + SameSite=Strict, scoped to
 * /admin; POSTs must also be same-origin (CSRF).
 */
import { hmacHex, safeEqual } from "../crypto";
import type { Env } from "../env";
import { log } from "../log";
import type { Network } from "../networks";
import { MARK, html, page, redirect } from "./html";
import {
  accessKey,
  clearFailures,
  findUserByLogin,
  getUser,
  grantsFor,
  normaliseLogin,
  recordFailure,
  tooManyFailures,
  touchLogin,
  verifyPassword,
} from "./users";

const COOKIE = "sm_admin";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
/** User id 0 = logged in with ADMIN_KEY. */
const KEY_USER = 0;

/** Who is looking at the panel, and what they may touch. */
export interface Viewer {
  id: number;
  name: string;
  login: string | null;
  owner: boolean;
  can(network: Network, accountId: string): boolean;
}

function keyViewer(): Viewer {
  return { id: KEY_USER, name: "Admin key", login: null, owner: true, can: () => true };
}

async function sign(key: string, uid: number, expiry: number, stamp: string): Promise<string> {
  return hmacHex(key, `admin-session:${uid}:${expiry}:${stamp}`);
}

export async function makeSession(key: string, uid: number, stamp: string, now = Date.now()): Promise<string> {
  const expiry = now + SESSION_MS;
  return `${uid}.${expiry}.${await sign(key, uid, expiry, stamp)}`;
}

/** The user id a cookie is for, if its signature and expiry check out for that stamp. */
export async function checkSession(
  key: string,
  value: string | null,
  stampFor: (uid: number) => Promise<string | null>,
  now = Date.now(),
): Promise<number | null> {
  const m = value?.match(/^(\d+)\.(\d+)\.([0-9a-f]{64})$/);
  if (!m) return null;
  const uid = Number(m[1]);
  const expiry = Number(m[2]);
  if (!(expiry > now)) return null;
  const stamp = await stampFor(uid);
  if (stamp === null) return null;
  return (await safeEqual(m[3], await sign(key, uid, expiry, stamp))) ? uid : null;
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

/** The logged-in viewer, from the session cookie or a Bearer ADMIN_KEY; null if neither. */
export async function currentViewer(request: Request, env: Env): Promise<Viewer | null> {
  if (!env.ADMIN_KEY) return null;
  const header = request.headers.get("Authorization") ?? "";
  if (header.startsWith("Bearer ") && (await safeEqual(header.slice(7), env.ADMIN_KEY))) return keyViewer();

  const cookie = readCookie(request, COOKIE);
  if (!cookie) return null;
  let user: Awaited<ReturnType<typeof getUser>> = null;
  const uid = await checkSession(env.ADMIN_KEY, cookie, async (id) => {
    if (id === KEY_USER) return "key";
    user = await getUser(env, id);
    return user?.pw_salt ?? null;
  });
  if (uid === null) return null;
  if (uid === KEY_USER) return keyViewer();
  const u = user!;
  if (u.role === "owner") return { id: u.id, name: u.name, login: u.login, owner: true, can: () => true };
  const grants = await grantsFor(env, u.id);
  return {
    id: u.id,
    name: u.name,
    login: u.login,
    owner: false,
    can: (network, accountId) => grants.has(accessKey(network, accountId)),
  };
}

/**
 * Is this POST from our own pages? A cross-site form can't ride the session
 * cookie anyway (SameSite=Strict); this also covers the login form.
 *
 * `Sec-Fetch-Site` first: browsers set it and pages can't forge it. Then
 * `Origin`. Note a form posted under `Referrer-Policy: no-referrer` sends
 * `Origin: null`, which is why the panel uses `same-origin` instead.
 */
export function sameOrigin(request: Request, url: URL): boolean {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site) return site === "same-origin";
  const origin = request.headers.get("Origin");
  return origin === null || origin === url.origin;
}

/** Only redirect back into the admin panel, never to another site. */
function safeNext(next: string | null): string {
  return next && /^\/admin(\/[\w\-./%?=&]*)?$/.test(next) && !next.startsWith("//") ? next : "/admin";
}

export function loginPage(url: URL, error?: string, status = 200, email = ""): Response {
  const next = safeNext(url.searchParams.get("next"));
  return page(
    "Log in",
    html`<div class="login"><div class="panel">
  ${MARK}
  <h1><span class="marker">Social Manager</span></h1>
  <p class="muted" style="margin:0 0 28px">Auto-replies for your Instagram and Facebook accounts.</p>
  <form class="form" method="post" action="/admin/login?next=${encodeURIComponent(next)}">
    <label class="field"><span>Email</span>
      <input type="email" name="email" value="${email}" autocomplete="username" autofocus></label>
    <label class="${error ? "field has-error" : "field"}"><span>Password</span>
      <input type="password" name="password" autocomplete="current-password" required>
      ${error ? html`<span class="err">${error}</span>` : html`<span class="hint">Owner with the <code>ADMIN_KEY</code>? Leave the email empty.</span>`}
    </label>
    <button class="btn btn-accent btn-wide" data-pending="Logging in…" data-label="Log in">Log in</button>
  </form>
</div></div>`,
    { nav: false, status },
  );
}

const sessionCookie = (value: string, maxAge: number) =>
  `${COOKIE}=${value}; Path=/admin; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;

export async function handleLogin(request: Request, url: URL, env: Env): Promise<Response> {
  if (!env.ADMIN_KEY) return loginPage(url, "ADMIN_KEY is not set on the Worker.", 503);
  if (!sameOrigin(request, url)) return new Response("Forbidden", { status: 403 });

  const form = await request.formData();
  const email = normaliseLogin(String(form.get("email") ?? ""));
  const password = String(form.get("password") ?? "");
  const throttleKey = email || "admin-key";
  const wrong = "That email and password don't match.";

  if (await tooManyFailures(env, throttleKey)) {
    log.warn("admin.login_throttled", { login: throttleKey });
    return loginPage(url, "Too many wrong passwords. Wait 15 minutes, then try again.", 429, email);
  }

  let uid: number | null = null;
  let stamp = "";
  if (!email) {
    if (password && (await safeEqual(password, env.ADMIN_KEY))) {
      uid = KEY_USER;
      stamp = "key";
    }
  } else {
    const user = await findUserByLogin(env, email);
    if (user && (await verifyPassword(password, user))) {
      uid = user.id;
      stamp = user.pw_salt;
      await touchLogin(env, user.id);
    }
  }

  if (uid === null) {
    await recordFailure(env, throttleKey);
    log.warn("admin.login_failed", { login: email || "(admin key)" });
    return loginPage(url, email ? wrong : "That isn't the admin key.", 401, email);
  }
  await clearFailures(env, throttleKey);
  log.info("admin.login", { user_id: uid });
  return redirect(safeNext(url.searchParams.get("next")), {
    "Set-Cookie": sessionCookie(await makeSession(env.ADMIN_KEY, uid, stamp), SESSION_MS / 1000),
  });
}

export function handleLogout(): Response {
  return redirect("/admin/login", { "Set-Cookie": sessionCookie("", 0) });
}
