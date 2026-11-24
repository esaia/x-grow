/**
 * Facebook Page webhook payloads → IncomingComment / IncomingDm.
 *
 *   object "page", entry[].id     the connected Page
 *   entry[].changes[] "feed"      value.item = "comment", value.verb = "add",
 *                                 value.comment_id, value.post_id, value.from{id,name}, value.message
 *   entry[].messaging[]           Messenger: sender.id (PSID), message.{mid,text,is_echo}
 *
 * Only new comments count: edits, deletes, reactions, new posts etc. in
 * `feed` are ignored.
 */
import { accountFor, guard, handleComment, handleDm } from "../autoreply/handle";
import type { Env } from "../env";
import { log } from "../log";
import { NETWORKS } from "../networks";
import { fetchFacebookComment } from "./client";

interface Payload {
  object?: string;
  entry?: {
    id?: string;
    changes?: {
      field?: string;
      value?: {
        item?: string;
        verb?: string;
        comment_id?: string;
        post_id?: string;
        parent_id?: string;
        from?: { id?: string; name?: string };
        message?: string;
      };
    }[];
    messaging?: {
      sender?: { id?: string };
      message?: { mid?: string; text?: string; is_echo?: boolean; is_deleted?: boolean };
    }[];
  }[];
}

export async function processFacebook(raw: unknown, env: Env): Promise<void> {
  const payload = raw as Payload;
  if (payload.object !== "page") {
    log.info("facebook.webhook.ignored", { object: payload.object });
    return;
  }
  for (const entry of payload.entry ?? []) {
    const account = await accountFor(env, "facebook", entry.id);
    if (!account) continue;
    const client = NETWORKS.facebook.client(env, account);

    for (const change of entry.changes ?? []) {
      const v = change.value;
      if (change.field !== "feed" || v?.item !== "comment" || v.verb !== "add" || !v.comment_id || !v.post_id) {
        log.info("facebook.webhook.change_ignored", {
          account: account.username,
          field: change.field,
          item: v?.item,
          verb: v?.verb,
        });
        continue;
      }
      await guard("comment", account, async () => {
        let text = v.message;
        let userId = v.from?.id;
        let username = v.from?.name;
        if (!text || !userId) {
          // Meta sometimes leaves the text (or author) out of feed webhooks; read the comment itself.
          try {
            const c = await fetchFacebookComment(env, account, v.comment_id!);
            text ||= c.text;
            userId ??= c.userId;
            username ??= c.username;
            log.info("facebook.comment.fetched_missing_fields", { comment_id: v.comment_id, has_text: !!c.text });
          } catch (err) {
            log.warn("facebook.comment.fetch_failed", { comment_id: v.comment_id, error: String(err), keys: Object.keys(v) });
          }
        }
        await handleComment(
          env,
          account,
          { commentId: v.comment_id!, mediaId: v.post_id!, userId, username, text: text ?? "" },
          client,
        );
      });
    }

    for (const m of entry.messaging ?? []) {
      const msg = m.message;
      if (!msg?.mid || !m.sender?.id) {
        log.info("facebook.dm.non_message_event", { account: account.username, keys: Object.keys(m) });
        continue;
      }
      await guard("dm", account, () =>
        handleDm(env, account, {
          mid: msg.mid!,
          senderId: m.sender!.id!,
          text: msg.text,
          own: !!msg.is_echo,
          skip: !!msg.is_deleted,
        }),
      );
    }
  }
}
