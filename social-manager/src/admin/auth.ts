/**
 * Admin panel login. The password is ADMIN_KEY; a successful login sets a
 * signed session cookie for 30 days:
 *
 *   sm_admin = <expiry ms>.<HMAC-SHA256(ADMIN_KEY, "admin-session:" + expiry)>
 *
 * Nothing is stored server-side. Changing ADMIN_KEY invalidates every session.
 * The cookie is HttpOnly + Secure + SameSite=Strict and scoped to /admin,
 * and POSTs must also come from our own origin (CSRF).
 *
 * /admin/api/* additionally accepts `Authorization: Bearer <ADMIN_KEY>` for curl.
 */
import { hmacHex, safeEqual } from "../crypto";
import type { Env } from "../env";
import { log } from "../log";
import { MARK, html, page, redirect } from "./html";

const COOKIE = "sm_admin";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

async function sign(key: string, expiry: number): Promise<string> {
  return hmacHex(key, `admin-session:${expiry}`);
}

export async function makeSession(key: string, now = Date.now()): Promise<string> {
  const expiry = now + SESSION_MS;
  return `${expiry}.${await sign(key, expiry)}`;
}

export async function checkSession(key: string, value: string | null, now = Date.now()): Promise<boolean> {
  const m = value?.match(/^(\d+)\.([0-9a-f]{64})$/);
  if (!m) return false;
  const expiry = Number(m[1]);
  if (!(expiry > now)) return false;
  return safeEqual(m[2], await sign(key, expiry));
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export async function isAdmin(request: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_KEY) return false;
  if (await checkSession(env.ADMIN_KEY, readCookie(request, COOKIE))) return true;
  const header = request.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") && (await safeEqual(header.slice(7), env.ADMIN_KEY));
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
  return next && /^\/admin(\/[\w\-./%?=&]*)?$/.test(next) && !next.startsWith("//") ? next : "/admin/instagram";
}

export function loginPage(url: URL, error?: string, status = 200): Response {
  const next = safeNext(url.searchParams.get("next"));
  return page(
    "Log in",
    html`<div class="login"><div class="panel">
  ${MARK}
  <h1><span class="marker">Social Manager</span></h1>
  <p class="muted" style="margin:0 0 28px">Auto-replies for your Instagram accounts.</p>
  <form class="form" method="post" action="/admin/login?next=${encodeURIComponent(next)}">
    <label class="${error ? "field has-error" : "field"}"><span>Password</span>
      <input type="password" name="password" autocomplete="current-password" required autofocus>
      ${error ? html`<span class="err">${error}</span>` : html`<span class="hint">The <code>ADMIN_KEY</code> secret.</span>`}
    </label>
    <button class="btn btn-accent btn-wide" data-pending="Logging in…" data-label="Log in">Log in</button>
  </form>
</div></div>`,
    { nav: false, status },
  );
}

export async function handleLogin(request: Request, url: URL, env: Env): Promise<Response> {
  if (!env.ADMIN_KEY) return loginPage(url, "ADMIN_KEY is not set on the Worker.", 503);
  if (!sameOrigin(request, url)) return new Response("Forbidden", { status: 403 });

  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  if (!password || !(await safeEqual(password, env.ADMIN_KEY))) {
    log.warn("admin.login_failed");
    return loginPage(url, "That password isn't right.", 401);
  }
  log.info("admin.login");
  const session = await makeSession(env.ADMIN_KEY);
  return redirect(safeNext(url.searchParams.get("next")), {
    "Set-Cookie": `${COOKIE}=${session}; Path=/admin; Max-Age=${SESSION_MS / 1000}; HttpOnly; Secure; SameSite=Strict`,
  });
}

export function handleLogout(): Response {
  return redirect("/admin/login", {
    "Set-Cookie": `${COOKIE}=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
  });
}
