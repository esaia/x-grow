/**
 * "Connect an Instagram account": Meta's Unified Login flow.
 *
 *   GET /connect/instagram           → redirect to Meta's login dialog
 *   GET /connect/instagram/callback  → code → token → save every account it covers
 *                                      → subscribe each to webhooks
 *
 * Who can connect is decided by Meta, not by us: with Standard Access only
 * people who have a role on the app can finish the login. That is why the
 * start route needs no admin key, and why opening this up to other people
 * later is App Review rather than a code change.
 *
 * CSRF: a random `state` goes in an HttpOnly cookie and in the login URL;
 * the callback requires both to match. Otherwise someone could make your
 * browser finish *their* login and attach their account here.
 */
import type { Env } from "../env";
import { MARK, html, page as adminPage, raw } from "../admin/html";
import { log } from "../log";
import { saveAccount } from "./db";
import { CALLBACK_PATH, OAUTH_DIALOG, WEBHOOK_FIELDS } from "./config";
import { GraphError, createGraph, exchangeCode } from "./graph";

const STATE_COOKIE = "ig_connect_state";

export function startConnect(url: URL, env: Env): Response {
  if (!env.META_APP_ID || !env.IG_LOGIN_CONFIG_ID) {
    return page("Not configured", `<p class="muted">Set META_APP_ID and IG_LOGIN_CONFIG_ID in wrangler.toml [vars].</p>`, 500);
  }
  const state = crypto.randomUUID();
  const dialog = new URL(OAUTH_DIALOG);
  dialog.search = new URLSearchParams({
    client_id: env.META_APP_ID,
    config_id: env.IG_LOGIN_CONFIG_ID,
    redirect_uri: `${url.origin}${CALLBACK_PATH}`,
    response_type: "code",
    // Present in the login URL the dashboard generates for this configuration.
    override_default_response_type: "true",
    state,
  }).toString();

  log.info("instagram.connect.start");
  return new Response(null, {
    status: 302,
    headers: {
      Location: dialog.toString(),
      "Set-Cookie": `${STATE_COOKIE}=${state}; Path=/connect/instagram; Max-Age=900; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

export async function finishConnect(request: Request, url: URL, env: Env): Promise<Response> {
  const p = url.searchParams;
  const clearCookie = `${STATE_COOKIE}=; Path=/connect/instagram; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

  if (p.get("error")) {
    log.warn("instagram.connect.denied", { error: p.get("error"), reason: p.get("error_reason") });
    return page(
      "Not connected",
      `<p class="muted">Meta said: ${esc(p.get("error_description") ?? p.get("error") ?? "")}</p><a class="btn btn-ghost btn-wide" href="/admin/instagram">Back to Social Manager</a>`,
      400,
      clearCookie,
    );
  }

  const cookieState = readCookie(request, STATE_COOKIE);
  const code = p.get("code");
  if (!code || !cookieState || p.get("state") !== cookieState) {
    log.warn("instagram.connect.bad_state", { has_code: !!code, has_cookie: !!cookieState });
    return page(
      "Link expired",
      `<p class="muted">The connection link only works for 15 minutes, in the browser that started it.</p><a class="btn btn-accent btn-wide" href="/connect/instagram">Start again</a>`,
      400,
      clearCookie,
    );
  }

  try {
    const token = await exchangeCode(env, code, `${url.origin}${CALLBACK_PATH}`);
    const graph = createGraph(env, token);
    const assigned = await graph.assignedAccounts();
    if (assigned.length === 0) {
      log.warn("instagram.connect.no_accounts");
      return page(
        "No Instagram account shared",
        `<p class="muted">The login finished, but no Instagram account was chosen. Start again and tick the account when Meta asks which ones to share.</p><a class="btn btn-accent btn-wide" href="/connect/instagram">Start again</a>`,
        400,
        clearCookie,
      );
    }

    const results: string[] = [];
    for (const a of assigned) {
      const username = a.username ?? a.id;
      await saveAccount(env, { id: a.id, username, token });
      try {
        await graph.subscribeWebhooks(a.id, WEBHOOK_FIELDS);
        log.info("instagram.connect.connected", { ig_id: a.id, username, webhooks: WEBHOOK_FIELDS });
        results.push(`<li><span class="dot dot-on"></span><span><b>@${esc(username)}</b> is connected and replying.</span></li>`);
      } catch (err) {
        // Saved anyway: the token works, only delivery is off. Reconnecting retries.
        const error = err instanceof GraphError ? err.toLog() : String(err);
        log.error("instagram.connect.subscribe_failed", { ig_id: a.id, username, error });
        results.push(
          `<li><span class="dot dot-bad"></span><span><b>@${esc(username)}</b> is connected, but Instagram wouldn't send its comments yet: ${esc(
            err instanceof Error ? err.message : String(err),
          )}. Connect it again to retry.</span></li>`,
        );
      }
    }
    return page(
      "Instagram connected",
      `<ul class="connected">${results.join("")}</ul><a class="btn btn-accent btn-wide" href="/admin/instagram">Open Social Manager</a>`,
      200,
      clearCookie,
    );
  } catch (err) {
    const error = err instanceof GraphError ? err.toLog() : String(err);
    log.error("instagram.connect.failed", { error });
    return page(
      "Connection failed",
      `<p class="muted">${esc(err instanceof Error ? err.message : String(err))}</p><a class="btn btn-accent btn-wide" href="/connect/instagram">Try again</a>`,
      502,
      clearCookie,
    );
  }
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** `body` is trusted HTML built here; anything from outside goes through esc(). */
function page(title: string, body: string, status: number, setCookie?: string): Response {
  const res = adminPage(
    title,
    html`<div class="login"><div class="panel">${MARK}<h1 style="font-size:30px;margin-bottom:14px">${title}</h1>
  <div class="connect-body">${raw(body)}</div></div></div>`,
    { nav: false, status },
  );
  if (setCookie) res.headers.set("Set-Cookie", setCookie);
  return res;
}
