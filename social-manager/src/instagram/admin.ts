/**
 * /admin/api/instagram/* — JSON for curl and scripts. Same auth as the panel
 * (session cookie, or `Authorization: Bearer <ADMIN_KEY>`). Tokens are never
 * returned.
 *
 *   GET /admin/api/instagram/accounts                       connected accounts + live token check
 *   GET /admin/api/instagram/media?account=<user>[&after=]  posts/Reels with media ids
 */
import type { Env } from "../env";
import { json } from "../http";
import { log } from "../log";
import { findAccountByUsername, listAccounts, listRules } from "./db";
import { GraphError, createGraph } from "./graph";

const PREFIX = "/admin/api/instagram";

export async function handleInstagramApi(request: Request, url: URL, env: Env): Promise<Response> {
  const route = `${request.method} ${url.pathname.replace(/\/+$/, "").slice(PREFIX.length)}`;
  try {
    if (route === "GET /accounts") {
      const accounts = await listAccounts(env);
      return json({
        accounts: await Promise.all(
          accounts.map(async (a) => {
            let token_ok: boolean | string = true;
            try {
              await createGraph(env, a.token).profile(a.id);
            } catch (err) {
              token_ok = err instanceof Error ? err.message : String(err);
            }
            return { id: a.id, username: a.username, connected_at: a.connected_at, token_ok };
          }),
        ),
      });
    }

    if (route === "GET /media") {
      const name = url.searchParams.get("account");
      if (!name) return json({ error: "Pass ?account=<username>" }, 400);
      const account = await findAccountByUsername(env, name);
      if (!account) return json({ error: `@${name} is not connected` }, 404);

      const [page, rules] = await Promise.all([
        createGraph(env, account.token).listMedia(account.id, url.searchParams.get("after") ?? undefined),
        listRules(env, account.id),
      ]);
      const configured = new Set(rules.map((r) => r.mediaId));
      const after = page.paging?.cursors?.after;
      return json({
        account: account.username,
        media: page.data.map((m) => ({
          id: m.id,
          configured: configured.has(m.id),
          type: m.media_product_type ?? m.media_type,
          posted: m.timestamp,
          permalink: m.permalink,
          caption: m.caption ? m.caption.slice(0, 100) : undefined,
        })),
        next:
          page.paging?.next && after
            ? `${PREFIX}/media?account=${encodeURIComponent(account.username)}&after=${after}`
            : null,
      });
    }

    return json({ error: `No route ${request.method} ${url.pathname}` }, 404);
  } catch (err) {
    const error = err instanceof GraphError ? err.toLog() : String(err);
    log.error("instagram.api_failed", { route, error });
    return json({ error }, 502);
  }
}
