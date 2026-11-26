/**
 * Facebook Pages: graph.facebook.com with a Page access token.
 *
 * Login gives a system-user token (Facebook Login for Business,
 * "Expiration: Never"); /me/accounts turns it into one Page token per Page.
 * Comments arrive on the Page's `feed` webhook, DMs on `messages`
 * (Messenger). Private replies follow the same rules as Instagram: one per
 * comment, within 7 days of it.
 */
import type { Account } from "../autoreply/db";
import type { Env } from "../env";
import { log } from "../log";
import { GraphError, graph, messageBody } from "../meta";
import type { Client, Connected, NetComment, Post } from "../networks";

/** Page webhook fields: comments are in `feed`, Messenger DMs in `messages`. */
const WEBHOOK_FIELDS = "feed,messages";

const POST_FIELDS =
  "id,message,created_time,permalink_url,full_picture,comments.summary(true).limit(0),reactions.summary(true).limit(0)";
const COMMENT_FIELDS = "id,message,created_time,from";

interface FbPost {
  id: string;
  message?: string;
  created_time?: string;
  permalink_url?: string;
  full_picture?: string;
  comments?: { summary?: { total_count?: number } };
  reactions?: { summary?: { total_count?: number } };
}

interface FbComment {
  id: string;
  message?: string;
  created_time?: string;
  /** Page-scoped id + name. Meta omits it for some users; dedup then falls back to the comment. */
  from?: { id?: string; name?: string };
  comments?: { data: FbComment[] };
}

type Paged<T> = { data: T[]; paging?: { cursors?: { after?: string }; next?: string } };

const toPost = (p: FbPost, views: number | null = null): Post => ({
  id: p.id,
  caption: p.message,
  permalink: p.permalink_url,
  thumbnail: p.full_picture,
  timestamp: p.created_time,
  views,
  likes: p.reactions?.summary?.total_count,
  comments: p.comments?.summary?.total_count,
});

const toComment = (c: FbComment): NetComment => ({
  id: c.id,
  text: c.message ?? "",
  timestamp: c.created_time,
  userId: c.from?.id,
  username: c.from?.name,
  replies: c.comments?.data.map(toComment),
});

const next = <T>(p: Paged<T>) => (p.paging?.next ? p.paging.cursors?.after : undefined);

export function facebookClient(env: Env, page: Pick<Account, "id" | "token">): Client {
  const { call, send } = graph(env, page.token);

  /**
   * Lifetime views: `post_media_view`, "the number of times your content was
   * played or displayed" (the impressions metrics are deprecated above v25).
   * Needs `read_insights`; Meta also only reports insights for Pages with
   * 100+ likes. Without it every call fails → `viewsNeedPermission`.
   */
  async function views(ids: string[]) {
    const results = await Promise.allSettled(
      ids.map((id) =>
        call<{ data: { name: string; values?: { value: number }[] }[] }>("GET", `/${id}/insights`, {
          metric: "post_media_view",
          // Without this Meta answers per day over a recent window, often empty.
          period: "lifetime",
        }),
      ),
    );
    const byId = new Map<string, number>();
    results.forEach((r, i) => {
      if (r.status !== "fulfilled") return;
      const v = r.value.data.find((d) => d.name === "post_media_view")?.values?.[0]?.value;
      if (typeof v === "number") byId.set(ids[i], v);
    });
    const firstError = results.find((r): r is PromiseRejectedResult => r.status === "rejected")?.reason;
    if (firstError && !(firstError instanceof GraphError && firstError.isPermissionError)) {
      log.warn("facebook.views_unavailable", {
        error: firstError instanceof GraphError ? firstError.toLog() : String(firstError),
      });
    }
    // Meta answers an empty list (not an error) when read_insights is missing
    // or the Page is under 100 likes, so "nothing for any post" counts too.
    return { byId, needPermission: ids.length > 0 && byId.size === 0 };
  }

  return {
    async check() {
      await call("GET", `/${page.id}`, { fields: "id,name" });
    },

    async posts(after) {
      const params: Record<string, string> = { fields: POST_FIELDS, limit: "24" };
      if (after) params.after = after;
      const res = await call<Paged<FbPost>>("GET", `/${page.id}/published_posts`, params);
      const v = await views(res.data.map((p) => p.id));
      return {
        items: res.data.map((p) => toPost(p, v.byId.get(p.id) ?? null)),
        after: next(res),
        viewsNeedPermission: v.needPermission,
      };
    },

    async post(id) {
      const [p, v] = await Promise.all([call<FbPost>("GET", `/${id}`, { fields: POST_FIELDS }), views([id])]);
      return toPost(p, v.byId.get(id) ?? null);
    },

    async comments(postId, after) {
      const params: Record<string, string> = {
        fields: `${COMMENT_FIELDS},comments.limit(50){${COMMENT_FIELDS}}`,
        filter: "toplevel",
        order: "reverse_chronological",
        limit: "50",
      };
      if (after) params.after = after;
      const res = await call<Paged<FbComment>>("GET", `/${postId}/comments`, params);
      return { items: res.data.map(toComment), after: next(res) };
    },

    privateReply: (commentId, message) =>
      send(`/${page.id}/messages`, { recipient: { comment_id: commentId }, message: messageBody(message) }, { message_id: "dry-run" }),

    sendDm: (recipientId, message) =>
      send(
        `/${page.id}/messages`,
        { recipient: { id: recipientId }, messaging_type: "RESPONSE", message: messageBody(message) },
        { message_id: "dry-run" },
      ),

    replyToComment: (commentId, message) => send(`/${commentId}/comments`, { message }, { id: "dry-run" }),

    unsubscribe: () => call("DELETE", `/${page.id}/subscribed_apps`),
  };
}

/**
 * After login: every Page the token can act for, each with its own Page
 * token, subscribed to `feed` + `messages`. /me/accounts is the documented
 * way; /me/assigned_pages is the system-user equivalent, tried second.
 */
export async function facebookConnect(env: Env, token: string): Promise<Connected[]> {
  const { call } = graph(env, token);
  type PageRow = { id: string; name?: string; access_token?: string };
  let pages: PageRow[] = [];
  for (const path of ["/me/accounts", "/me/assigned_pages"]) {
    try {
      const res = await call<{ data: PageRow[] }>("GET", path, { fields: "id,name,access_token", limit: "100" });
      if (res.data.length) {
        pages = res.data;
        break;
      }
    } catch {
      // try the next listing
    }
  }

  const out: Connected[] = [];
  for (const p of pages) {
    const pageToken = p.access_token ?? token;
    let subscribeError: string | null = null;
    try {
      await graph(env, pageToken).call("POST", `/${p.id}/subscribed_apps`, { subscribed_fields: WEBHOOK_FIELDS });
    } catch (err) {
      subscribeError = err instanceof Error ? err.message : String(err);
    }
    out.push({ id: p.id, username: p.name ?? p.id, token: pageToken, subscribeError });
  }
  return out;
}

/**
 * One comment, read fresh. Feed webhooks sometimes arrive without `message`
 * (and occasionally without `from`), so the webhook fills the gaps from here
 * before matching keywords.
 */
export async function fetchFacebookComment(
  env: Env,
  page: Pick<Account, "token">,
  commentId: string,
): Promise<{ text: string; userId?: string; username?: string }> {
  const c = await graph(env, page.token).call<FbComment>("GET", `/${commentId}`, { fields: COMMENT_FIELDS });
  return { text: c.message ?? "", userId: c.from?.id, username: c.from?.name };
}
