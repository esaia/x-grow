/**
 * social-manager: one Worker, one folder per network under src/.
 *
 *   /admin                        admin panel (login: ADMIN_KEY)
 *   /admin/instagram/...          Instagram accounts, auto-replies, activity
 *   /admin/api/instagram/...      the same data as JSON, for curl
 *   GET  /connect/instagram       connect an Instagram account (Meta login)
 *   GET  /connect/instagram/callback
 *   GET  /webhooks/instagram      Meta's subscription check
 *   POST /webhooks/instagram      comment + DM events (signature-verified)
 *   cron (daily)                  housekeeping
 *
 * A new network adds its own `/connect/<network>`, `/webhooks/<network>`,
 * `/admin/<network>` and `/admin/api/<network>` branches here.
 */
import { handleLogin, handleLogout, isAdmin, loginPage, sameOrigin } from "./admin/auth";
import { redirect } from "./admin/html";
import type { Env } from "./env";
import { json } from "./http";
import { handleInstagramApi } from "./instagram/admin";
import { CALLBACK_PATH } from "./instagram/config";
import { finishConnect, startConnect } from "./instagram/connect";
import { cleanup } from "./instagram/db";
import { handleInstagramPanel } from "./instagram/panel";
import { receiveWebhook, verifySubscription } from "./instagram/webhook";
import { log } from "./log";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;

    if (path === "/webhooks/instagram") {
      if (method === "GET") return verifySubscription(url, env);
      if (method === "POST") return receiveWebhook(request, env, ctx);
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (method === "GET" && path === "/connect/instagram") return startConnect(url, env);
    if (method === "GET" && path === CALLBACK_PATH) return finishConnect(request, url, env);

    if (path === "/admin" || path.startsWith("/admin/")) return admin(request, url, path, env);

    if (path === "/") return redirect("/admin");
    return new Response("Not Found", { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      cleanup(env).then(
        (removed) => log.info("cron.cleanup", { cron: controller.cron, removed }),
        (err) => log.error("cron.cleanup_failed", { error: String(err) }),
      ),
    );
  },
} satisfies ExportedHandler<Env>;

async function admin(request: Request, url: URL, path: string, env: Env): Promise<Response> {
  const method = request.method;
  if (path === "/admin/login") {
    if (method === "POST") return handleLogin(request, url, env);
    return loginPage(url);
  }

  const api = path.startsWith("/admin/api/");
  if (!(await isAdmin(request, env))) {
    if (api) return json({ error: "Unauthorized" }, 401);
    if (method !== "GET") return redirect("/admin/login");
    return redirect(`/admin/login?next=${encodeURIComponent(path + url.search)}`);
  }
  if (method !== "GET" && !sameOrigin(request, url)) return new Response("Forbidden", { status: 403 });

  if (path === "/admin/logout" && method === "POST") return handleLogout();
  if (path === "/admin") return redirect("/admin/instagram");
  if (path === "/admin/instagram" || path.startsWith("/admin/instagram/")) {
    return handleInstagramPanel(request, url, env);
  }
  if (path.startsWith("/admin/api/instagram/")) return handleInstagramApi(request, url, env);
  return api ? json({ error: "Not Found" }, 404) : new Response("Not Found", { status: 404 });
}
