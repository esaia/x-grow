/**
 * Instagram (API with Unified Login): graph.facebook.com with a system-user
 * token that never expires. `/me` is the system user, not an Instagram
 * account; /me/assigned_instagram_accounts lists the accounts, and their
 * `id` equals the webhook `entry[].id`.
 */
import type { Account } from "../autoreply/db";
import type { Env } from "../env";
import { GraphError, graph, messageBody } from "../meta";
import type { Client, Connected, NetComment, Post } from "../networks";

/**
 * Webhook fields each connected account is subscribed to. `messaging_postbacks`
 * delivers button taps; it must also be ticked in the app's webhook settings.
 */
const WEBHOOK_FIELDS = "comments,messages,messaging_postbacks";

const MEDIA_FIELDS =
  "id,caption,permalink,media_type,media_product_type,timestamp,thumbnail_url,media_url,like_count,comments_count";
const COMMENT_FIELDS = "id,text,timestamp,username,from{id,username}";

interface IgMedia {
  id: string;
  caption?: string;
  permalink?: string;
  media_type?: string;
  timestamp?: string;
  thumbnail_url?: string;
  media_url?: string;
  like_count?: number;
  comments_count?: number;
}

interface IgComment {
  id: string;
  text?: string;
  timestamp?: string;
  username?: string;
  from?: { id?: string; username?: string };
  replies?: { data: IgComment[] };
}

type Paged<T> = { data: T[]; paging?: { cursors?: { after?: string }; next?: string } };

const toPost = (m: IgMedia, views: number | null = null): Post => ({
  id: m.id,
  caption: m.caption,
  permalink: m.permalink,
  thumbnail: m.thumbnail_url ?? (m.media_type === "VIDEO" ? undefined : m.media_url),
  timestamp: m.timestamp,
  views,
  likes: m.like_count,
  comments: m.comments_count,
});

const toComment = (c: IgComment): NetComment => ({
  id: c.id,
  text: c.text ?? "",
  timestamp: c.timestamp,
  userId: c.from?.id,
  username: c.from?.username ?? c.username,
  replies: c.replies?.data.map(toComment),
});

const next = <T>(p: Paged<T>) => (p.paging?.next ? p.paging.cursors?.after : undefined);

export function instagramClient(env: Env, account: Pick<Account, "id" | "token">): Client {
  const { call, send } = graph(env, account.token);
  const fake = { message_id: "dry-run" };

  /**
   * Lifetime views. Needs `instagram_manage_insights`; without it Meta
   * answers with a permission error, reported as `viewsNeedPermission`.
   */
  async function views(ids: string[]) {
    const results = await Promise.allSettled(
      ids.map((id) =>
        call<{ data: { name: string; values?: { value: number }[]; total_value?: { value: number } }[] }>(
          "GET",
          `/${id}/insights`,
          { metric: "views" },
        ),
      ),
    );
    const byId = new Map<string, number>();
    let permissionErrors = 0;
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        const m = r.value.data.find((d) => d.name === "views");
        const v = m?.total_value?.value ?? m?.values?.[0]?.value;
        if (v !== undefined) byId.set(ids[i], v);
      } else if (r.reason instanceof GraphError && r.reason.isPermissionError) permissionErrors++;
    });
    return { byId, needPermission: byId.size === 0 && permissionErrors > 0 };
  }

  return {
    async check() {
      await call("GET", `/${account.id}`, { fields: "id,username" });
    },

    async posts(after) {
      const params: Record<string, string> = { fields: MEDIA_FIELDS, limit: "24" };
      if (after) params.after = after;
      const page = await call<Paged<IgMedia>>("GET", `/${account.id}/media`, params);
      const v = await views(page.data.map((m) => m.id));
      return {
        items: page.data.map((m) => toPost(m, v.byId.get(m.id) ?? null)),
        after: next(page),
        viewsNeedPermission: v.needPermission,
      };
    },

    async post(id) {
      const [m, v] = await Promise.all([call<IgMedia>("GET", `/${id}`, { fields: MEDIA_FIELDS }), views([id])]);
      return toPost(m, v.byId.get(id) ?? null);
    },

    async comments(postId, after) {
      const params: Record<string, string> = {
        fields: `${COMMENT_FIELDS},replies.limit(50){${COMMENT_FIELDS}}`,
        limit: "50",
      };
      if (after) params.after = after;
      const page = await call<Paged<IgComment>>("GET", `/${postId}/comments`, params);
      return { items: page.data.map(toComment), after: next(page) };
    },

    privateReply: (commentId, message) =>
      send(`/${account.id}/messages`, { recipient: { comment_id: commentId }, message: messageBody(message) }, fake),

    sendDm: (recipientId, message) =>
      send(`/${account.id}/messages`, { recipient: { id: recipientId }, message: messageBody(message) }, fake),

    /**
     * User Profile API. Meta only answers once the person has messaged the
     * account or tapped a button (that is their consent), which is why the
     * follow check happens on the tap, never on the comment.
     */
    async follower(userId) {
      const p = await call<{ username?: string; is_user_follow_business?: boolean }>("GET", `/${userId}`, {
        fields: "username,is_user_follow_business",
      });
      if (typeof p.is_user_follow_business !== "boolean") throw new Error("Instagram didn't say whether they follow.");
      return { follows: p.is_user_follow_business, username: p.username };
    },

    replyToComment: (commentId, message) => send(`/${commentId}/replies`, { message }, { id: "dry-run" }),

    unsubscribe: () => call("DELETE", `/${account.id}/subscribed_apps`),
  };
}

/** After login: every Instagram account the token was given, with webhooks switched on. */
export async function instagramConnect(env: Env, token: string): Promise<Connected[]> {
  const { call } = graph(env, token);
  const res = await call<{ data: { id: string; username?: string }[] }>("GET", "/me/assigned_instagram_accounts", {
    fields: "id,username",
    limit: "100",
  });
  const out: Connected[] = [];
  for (const a of res.data) {
    let subscribeError: string | null = null;
    try {
      await call("POST", `/${a.id}/subscribed_apps`, { subscribed_fields: WEBHOOK_FIELDS });
    } catch (err) {
      subscribeError = err instanceof Error ? err.message : String(err);
    }
    out.push({ id: a.id, username: a.username ?? a.id, token, subscribeError });
  }
  return out;
}
