/**
 * The contract every network implements, and the registry of networks.
 *
 * Everything in src/autoreply/ (matching, dedup, past comments, the admin
 * panel) is written against `Client`, so adding a network means writing one
 * client + one webhook parser + one entry in NETWORKS, not another panel.
 */
import type { Account } from "./autoreply/db";
import type { Env } from "./env";
import { facebookClient, facebookConnect } from "./facebook/client";
import { instagramClient, instagramConnect } from "./instagram/client";

export type Network = "instagram" | "facebook";

/** A Reel, post or video, normalised across networks. */
export interface Post {
  id: string;
  caption?: string;
  permalink?: string;
  /** Cover image; CDN URL, valid for a few days. */
  thumbnail?: string;
  timestamp?: string;
  /** null → this network/token can't tell (e.g. missing insights permission). */
  views?: number | null;
  likes?: number;
  comments?: number;
}

export interface NetComment {
  id: string;
  text: string;
  timestamp?: string;
  /** Commenter's id within this network; dedup is per person. */
  userId?: string;
  username?: string;
  replies?: NetComment[];
}

export interface Page<T> {
  items: T[];
  /** Cursor for the next (older) page, if any. */
  after?: string;
}

export interface Client {
  /** Throws if the token no longer works. */
  check(): Promise<void>;
  posts(after?: string): Promise<Page<Post> & { viewsNeedPermission?: boolean }>;
  post(id: string): Promise<Post>;
  comments(postId: string, after?: string): Promise<Page<NetComment>>;
  /** DM to the author of a comment. One per comment, within 7 days of it. */
  privateReply(commentId: string, text: string): Promise<unknown>;
  /** DM reply to someone who messaged the account (24h window). */
  sendDm(recipientId: string, text: string): Promise<unknown>;
  /** Public reply under a comment. */
  replyToComment(commentId: string, text: string): Promise<unknown>;
  unsubscribe(): Promise<unknown>;
}

/** What one login gives us: each account it covers, ready to save. */
export interface Connected {
  id: string;
  username: string;
  token: string;
  /** null → webhooks are on; otherwise why turning them on failed. */
  subscribeError: string | null;
}

export interface NetworkInfo {
  label: string;
  /** "account" / "Page" */
  accountNoun: string;
  /** "@llamapresenter" vs "LlamaPresenter" */
  display(username: string): string;
  /** "Reels and posts" / "Posts" */
  postsTitle: string;
  /** "Reel" / "post" */
  postNoun: string;
  /** Permission the login configuration needs for view counts. */
  viewsPermission: string;
  /** Var holding this network's Meta login configuration id. */
  configId(env: Env): string | undefined;
  client(env: Env, account: Account): Client;
  /** After login: the accounts this token covers, saved and subscribed by the caller. */
  connect(env: Env, token: string): Promise<Connected[]>;
}

export const NETWORKS: Record<Network, NetworkInfo> = {
  instagram: {
    label: "Instagram",
    accountNoun: "account",
    display: (u) => `@${u}`,
    postsTitle: "Reels and posts",
    postNoun: "Reel",
    viewsPermission: "instagram_manage_insights",
    configId: (env) => env.IG_LOGIN_CONFIG_ID,
    client: instagramClient,
    connect: instagramConnect,
  },
  facebook: {
    label: "Facebook",
    accountNoun: "Page",
    display: (u) => u,
    postsTitle: "Posts",
    postNoun: "post",
    viewsPermission: "read_insights",
    configId: (env) => env.FB_LOGIN_CONFIG_ID,
    client: facebookClient,
    connect: facebookConnect,
  },
};

export function isNetwork(s: string): s is Network {
  return Object.hasOwn(NETWORKS, s);
}
