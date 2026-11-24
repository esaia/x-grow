/**
 * /admin/api/<network>/* — JSON for curl and scripts. Same auth as the panel
 * (session cookie, or `Authorization: Bearer <ADMIN_KEY>`). Tokens are never
 * returned.
 *
 *   GET /admin/api/<network>/accounts                     connected accounts + live token check
 *   GET /admin/api/<network>/posts?account=<id>[&after=]  posts with ids, stats and whether set up
 */
import type { Env } from "../env";
import { json } from "../http";
import { log } from "../log";
import { GraphError } from "../meta";
import { NETWORKS, type Network } from "../networks";
import { getAccount, listAccounts, listRules } from "./db";

export async function handleApi(request: Request, url: URL, env: Env, network: Network): Promise<Response> {
  const prefix = `/admin/api/${network}`;
  const route = `${request.method} ${url.pathname.replace(/\/+$/, "").slice(prefix.length)}`;
  try {
    if (route === "GET /accounts") {
      const accounts = await listAccounts(env, network);
      return json({
        accounts: await Promise.all(
          accounts.map(async (a) => {
            let token_ok: boolean | string = true;
            try {
              await NETWORKS[network].client(env, a).check();
            } catch (err) {
              token_ok = err instanceof Error ? err.message : String(err);
            }
            return { id: a.id, username: a.username, connected_at: a.connected_at, token_ok };
          }),
        ),
      });
    }

    if (route === "GET /posts") {
      const id = url.searchParams.get("account");
      if (!id) return json({ error: "Pass ?account=<id>" }, 400);
      const account = await getAccount(env, network, id);
      if (!account) return json({ error: "Not connected" }, 404);
      const [page, rules] = await Promise.all([
        NETWORKS[network].client(env, account).posts(url.searchParams.get("after") ?? undefined),
        listRules(env, account),
      ]);
      const configured = new Set(rules.map((r) => r.mediaId));
      return json({
        account: account.username,
        posts: page.items.map((p) => ({ ...p, caption: p.caption?.slice(0, 100), configured: configured.has(p.id) })),
        next: page.after ? `${prefix}/posts?account=${encodeURIComponent(id)}&after=${page.after}` : null,
      });
    }

    return json({ error: `No route ${request.method} ${url.pathname}` }, 404);
  } catch (err) {
    const error = err instanceof GraphError ? err.toLog() : String(err);
    log.error(`${network}.api_failed`, { route, error });
    return json({ error }, 502);
  }
}
