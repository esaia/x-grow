/**
 * "Connect an account": Meta's login flow, for any Meta network.
 *
 *   GET /connect/<network>           → redirect to Meta's login dialog
 *   GET /connect/<network>/callback  → code → token → the network lists the
 *                                      accounts/Pages it covers → saved + webhooks on
 *
 * Who can connect is decided by Meta, not by us: with Standard Access only
 * people with a role on the app can finish the login. That is why the start
 * route needs no admin key.
 *
 * CSRF: a random `state` goes in an HttpOnly cookie and in the login URL;
 * the callback requires both to match, so nobody can make your browser
 * finish *their* login and attach their account here.
 */
import { saveAccount } from "./autoreply/db";
import { MARK, html, page as adminPage, type SafeHtml } from "./admin/html";
import type { Env } from "./env";
import { log } from "./log";
import { GraphError, OAUTH_DIALOG, exchangeCode } from "./meta";
import { NETWORKS, type Network } from "./networks";

const COOKIE = "sm_connect_state";
const cookie = (value: string, maxAge: number) =>
  `${COOKIE}=${value}; Path=/connect; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
const callbackUrl = (url: URL, network: Network) => `${url.origin}/connect/${network}/callback`;

export function startConnect(url: URL, env: Env, network: Network): Response {
  const configId = NETWORKS[network].configId(env);
  if (!env.META_APP_ID || !configId || configId.startsWith("REPLACE")) {
    return result(
      "Not set up yet",
      html`<p class="muted">${NETWORKS[network].label} needs its Meta login configuration id in wrangler.toml [vars]
      before accounts can connect.</p><a class="btn btn-ghost btn-wide" href="/admin">Back to Social Manager</a>`,
      500,
    );
  }
  const state = `${network}.${crypto.randomUUID()}`;
  const dialog = new URL(OAUTH_DIALOG);
  dialog.search = new URLSearchParams({
    client_id: env.META_APP_ID,
    config_id: configId,
    redirect_uri: callbackUrl(url, network),
    response_type: "code",
    override_default_response_type: "true",
    state,
  }).toString();
  log.info(`${network}.connect.start`);
  return new Response(null, { status: 302, headers: { Location: dialog.toString(), "Set-Cookie": cookie(state, 900) } });
}

export async function finishConnect(request: Request, url: URL, env: Env, network: Network): Promise<Response> {
  const p = url.searchParams;
  const info = NETWORKS[network];
  const back = html`<a class="btn btn-accent btn-wide" href="/admin/${network}">Open Social Manager</a>`;
  const again = (label: string) => html`<a class="btn btn-accent btn-wide" href="/connect/${network}">${label}</a>`;

  if (p.get("error")) {
    log.warn(`${network}.connect.denied`, { error: p.get("error"), reason: p.get("error_reason") });
    return result("Not connected", html`<p class="muted">Meta said: ${p.get("error_description") ?? p.get("error")}</p>${back}`, 400);
  }

  const state = readCookie(request);
  const code = p.get("code");
  if (!code || !state || p.get("state") !== state || !state.startsWith(`${network}.`)) {
    log.warn(`${network}.connect.bad_state`, { has_code: !!code, has_cookie: !!state });
    return result(
      "Link expired",
      html`<p class="muted">The connection link only works for 15 minutes, in the browser that started it.</p>${again("Start again")}`,
      400,
    );
  }

  try {
    const token = await exchangeCode(env, code, callbackUrl(url, network));
    const accounts = await info.connect(env, token);
    if (accounts.length === 0) {
      log.warn(`${network}.connect.none_shared`);
      return result(
        `No ${info.accountNoun} shared`,
        html`<p class="muted">The login finished, but no ${info.label} ${info.accountNoun} was chosen. Start again and tick it
        when Meta asks what to share.</p>${again("Start again")}`,
        400,
      );
    }
    for (const a of accounts) {
      await saveAccount(env, { network, id: a.id, username: a.username, token: a.token });
      log[a.subscribeError ? "error" : "info"](`${network}.connect.connected`, {
        id: a.id,
        username: a.username,
        webhooks_error: a.subscribeError,
      });
    }
    return result(
      `${info.label} connected`,
      html`<ul class="connected">${accounts.map((a) =>
        a.subscribeError
          ? html`<li><span class="dot dot-bad"></span><span><b>${info.display(a.username)}</b> is connected, but Meta wouldn't
            send its comments yet: ${a.subscribeError}. Connect it again to retry.</span></li>`
          : html`<li><span class="dot dot-on"></span><span><b>${info.display(a.username)}</b> is connected and replying.</span></li>`,
      )}</ul>${back}`,
      200,
    );
  } catch (err) {
    log.error(`${network}.connect.failed`, { error: err instanceof GraphError ? err.toLog() : String(err) });
    return result("Connection failed", html`<p class="muted">${err instanceof Error ? err.message : String(err)}</p>${again("Try again")}`, 502);
  }
}

function readCookie(request: Request): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return null;
}

function result(title: string, body: SafeHtml, status: number): Response {
  const res = adminPage(
    title,
    html`<div class="login"><div class="panel">${MARK}<h1 style="font-size:30px;margin-bottom:14px">${title}</h1>
  <div class="connect-body">${body}</div></div></div>`,
    { nav: false, status },
  );
  res.headers.set("Set-Cookie", cookie("", 0));
  return res;
}
