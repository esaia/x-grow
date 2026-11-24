/**
 * Instagram webhook payloads → IncomingComment / IncomingDm.
 *
 *   entry[].id                    the connected Instagram account
 *   entry[].changes[] "comments"  value.comment_id (Unified Login) or value.id,
 *                                 value.from{id,username}, value.media.id, value.text
 *   entry[].messaging[]           sender.id, message.{mid,text,is_echo,is_self,...}
 */
import { accountFor, guard, handleComment, handleDm } from "../autoreply/handle";
import type { Env } from "../env";
import { log } from "../log";
import { NETWORKS } from "../networks";

interface Payload {
  object?: string;
  entry?: {
    id?: string;
    changes?: {
      field?: string;
      value?: {
        comment_id?: string;
        id?: string;
        text?: string;
        from?: { id?: string; username?: string };
        media?: { id?: string };
      };
    }[];
    messaging?: {
      sender?: { id?: string };
      message?: {
        mid?: string;
        text?: string;
        is_echo?: boolean;
        is_self?: boolean;
        is_deleted?: boolean;
        is_unsupported?: boolean;
      };
    }[];
  }[];
}

export async function processInstagram(raw: unknown, env: Env): Promise<void> {
  const payload = raw as Payload;
  if (payload.object !== "instagram") {
    log.info("instagram.webhook.ignored", { object: payload.object });
    return;
  }
  // Sequential on purpose: firing a batch at once burns the hourly limit in bursts.
  for (const entry of payload.entry ?? []) {
    const account = await accountFor(env, "instagram", entry.id);
    if (!account) continue;
    const client = NETWORKS.instagram.client(env, account);

    for (const change of entry.changes ?? []) {
      const v = change.value;
      const commentId = v?.comment_id ?? v?.id;
      if (change.field !== "comments" || !v || !commentId || !v.media?.id) {
        log.info("instagram.webhook.change_ignored", { account: account.username, field: change.field });
        continue;
      }
      await guard("comment", account, () =>
        handleComment(
          env,
          account,
          { commentId, mediaId: v.media!.id!, userId: v.from?.id, username: v.from?.username, text: v.text ?? "" },
          client,
        ),
      );
    }

    for (const m of entry.messaging ?? []) {
      const msg = m.message;
      if (!msg?.mid || !m.sender?.id) {
        log.info("instagram.dm.non_message_event", { account: account.username, keys: Object.keys(m) });
        continue;
      }
      await guard("dm", account, () =>
        handleDm(env, account, {
          mid: msg.mid!,
          senderId: m.sender!.id!,
          text: msg.text,
          own: !!(msg.is_echo || msg.is_self),
          skip: !!(msg.is_deleted || msg.is_unsupported),
        }),
      );
    }
  }
}
