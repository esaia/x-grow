/**
 * social-manager: one Worker, one adapter per network (src/<network>/), one
 * shared auto-reply engine and admin panel (src/autoreply/).
 *
 *   /admin                            admin panel (login: ADMIN_KEY)
 *   /admin/<network>/...              accounts, auto-replies, activity, past comments
 *   /admin/api/<network>/...          the same data as JSON, for curl
 *   GET  /connect/<network>           connect an account / Page (Meta login)
 *   GET  /connect/<network>/callback
 *   GET  /webhooks/<network>          Meta's subscription check
 *   POST /webhooks/<network>          comment + DM events (signature-verified)
 *   cron (daily)                      housekeeping
 *
 * <network> is instagram or facebook (see NETWORKS in networks.ts).
 */
import { handleLogin, handleLogout, isAdmin, loginPage, sameOrigin } from "./admin/auth";
import { redirect } from "./admin/html";
import { handleApi } from "./autoreply/api";
import { cleanup } from "./autoreply/db";
import { handlePanel } from "./autoreply/panel";
import { finishConnect, startConnect } from "./connect";
import type { Env } from "./env";
import { processFacebook } from "./facebook/webhook";
import { json } from "./http";
import { processInstagram } from "./instagram/webhook";
import { log } from "./log";
import { isNetwork, type Network } from "./networks";
import { receiveWebhook, verifySubscription } from "./webhooks";

const PROCESS: Record<Network, (payload: unknown, env: Env) => Promise<void>> = {
  instagram: processInstagram,
  facebook: processFacebook,
};

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;
    const [, first, network, rest] = path.split("/");

    if (first === "webhooks" && network && isNetwork(network) && !rest) {
      if (method === "GET") return verifySubscription(url, env, network);
      if (method === "POST") return receiveWebhook(request, env, ctx, network, PROCESS[network]);
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (first === "connect" && network && isNetwork(network) && method === "GET") {
      if (!rest) return startConnect(url, env, network);
      if (rest === "callback") return finishConnect(request, url, env, network);
    }

    if (first === "admin") return admin(request, url, path, env);
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
  if (path === "/admin/login") return method === "POST" ? handleLogin(request, url, env) : loginPage(url);

  const parts = path.split("/").filter(Boolean); // ["admin", ...]
  const api = parts[1] === "api";
  if (!(await isAdmin(request, env))) {
    if (api) return json({ error: "Unauthorized" }, 401);
    if (method !== "GET") return redirect("/admin/login");
    return redirect(`/admin/login?next=${encodeURIComponent(path + url.search)}`);
  }
  if (method !== "GET" && !sameOrigin(request, url)) return new Response("Forbidden", { status: 403 });

  if (path === "/admin/logout" && method === "POST") return handleLogout();
  if (path === "/admin") return redirect("/admin/instagram");

  const network = api ? parts[2] : parts[1];
  if (network && isNetwork(network)) {
    return api ? handleApi(request, url, env, network) : handlePanel(request, url, env, network);
  }
  return api ? json({ error: "Not Found" }, 404) : new Response("Not Found", { status: 404 });
}
