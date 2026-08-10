import type { PostCategory, PostFormat, RemixCloseness } from '@/lib/ai/prompts';
import type { XAccount } from '@/lib/xdom';

export type { XAccount };

/**
 * Domain records. These mirror the tables the Laravel platform used to own,
 * minus every `user_id` (the extension is single-user by construction) and
 * every LinkedIn / social-account column (X-only now).
 */

/** The writing-style profile the AI mimics. One record, always id 1. */
export interface VoiceProfile {
  tone: string;
  sample_posts: string | null;
  dos: string | null;
  donts: string | null;
  bio_context: string | null;
  facts: string | null;
  links: string | null;
  projects: string | null;
  topics: string | null;
  news_context: string | null;
  audience: string | null;
  x_handle: string | null;
  voice_analysis: string | null;
  learned_posts: string | null;
  voice_learned_at: string | null;
}

export function emptyVoiceProfile(): VoiceProfile {
  return {
    tone: 'balanced',
    sample_posts: null,
    dos: null,
    donts: null,
    bio_context: null,
    facts: null,
    links: null,
    projects: null,
    topics: null,
    news_context: null,
    audience: null,
    x_handle: null,
    voice_analysis: null,
    learned_posts: null,
    voice_learned_at: null,
  };
}

export type GenerationType = 'reply' | 'post';

export interface GenerationMeta {
  tone?: string;
  format?: PostFormat;
  has_thread?: boolean;
  weekly_schedule?: boolean;
  regenerate?: boolean;
  inspiration?: boolean;
  closeness?: string;
  source_tweet_id?: string;
  source_username?: string;
  category?: PostCategory;
}

/** Flat audit log of every AI call. */
export interface Generation {
  id: number;
  type: GenerationType;
  input_context: string | null;
  meta: GenerationMeta | null;
  output: string[];
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  created_at: string;
}

export const POST_STATUSES = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  posted: 'Posted',
  failed: 'Failed',
} as const;

export type PostStatus = keyof typeof POST_STATUSES;

/**
 * A single scheduled post.
 *
 * `scheduled_at` is a **naive wall-clock** value ("2026-08-12T09:00") paired
 * with the IANA `timezone` it was chosen in. Never construct a Date from it
 * directly for display — that re-interprets it in the browser's zone and
 * silently shifts the time. Use realScheduledAt() (lib/db) to get the real
 * instant, and read HH:MM straight out of the string to show it.
 */
export interface ScheduledPost {
  id: number;
  content: string;
  category: PostCategory | null;
  status: PostStatus;
  error: string | null;
  scheduled_at: string;
  timezone: string | null;
  posted_at: string | null;
  external_post_id: string | null;
  generation_id: number | null;
  created_at: string;
  updated_at: string;
}

/** A creator whose best posts we collect. Keyed by lowercase @handle. */
export interface Creator {
  username: string;
  name: string | null;
  avatar_url: string | null;
  followers_count: number | null;
  last_scanned_at: string | null;
}

export interface PostMetrics {
  like: number;
  reply: number;
  retweet: number;
  quote: number;
}

/** One harvested post from a tracked creator. */
export interface InspirationPost {
  username: string;
  x_tweet_id: string;
  content: string;
  url: string;
  posted_at: string | null;
  metrics: PostMetrics;
  /** Engagement relative to this creator's own mean. See lib/scoring.ts. */
  baseline_multiplier: number;
}

/** Payload the content script sends after scraping a profile. */
export interface IngestPayload {
  handle: string;
  /**
   * Wipe this creator's stored posts before saving the batch. Only set by a
   * "refresh everything" run — a normal harvest must add to what is stored,
   * since it only ever sees whatever the page had loaded.
   */
  replace?: boolean;
  profile: {
    name: string | null;
    avatar_url: string | null;
    followers_count: number | null;
  };
  posts: {
    x_tweet_id: string;
    content: string;
    url: string;
    posted_at: string | null;
    metrics: PostMetrics;
  }[];
}

export interface IngestResponse {
  username: string;
  received: number;
  stored: number;
}

/** A tracked creator plus its post count, for list UIs. */
export interface CreatorSummary extends Creator {
  posts_count: number;
}

export interface CreatorsResponse {
  creators: CreatorSummary[];
}

/** Request/response shapes for generation, unchanged from the API era. */
export interface ReplyPayload {
  tweet: string;
  thread_context?: string;
  tone?: string;
  count?: number;
}

export interface PostPayload {
  topic: string;
  format?: PostFormat;
  tone?: string;
  count?: number;
}

/** "Remix this post" — rewrite a creator's viral post in the owner's voice. */
export interface RemixPayload {
  content: string;
  closeness: RemixCloseness;
  instructions?: string | null;
  source_tweet_id: string;
  source_username: string;
}

export interface GenerateResponse {
  generation_id: number;
  type: GenerationType;
  options: string[];
  model: string;
}

export interface RecentPayload {
  type: GenerationType;
  input_context: string;
}

export interface RecentResponse {
  generations: Generation[];
}

/** Settings + usage, the replacement for the old AuthState. */
export interface SettingsState {
  /** The connected X account, or null until the user confirms one. */
  account: XAccount | null;
  /** Whether an OpenAI key is set. The key itself never leaves the worker. */
  hasKey: boolean;
  model: string;
  baseUrl: string;
  usage: { today: number; total: number };
  voiceProfile: VoiceProfile | null;
}

/** Shape of the {ok, data|error} envelope every messaging call replies with. */
export type BgResponseLike<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/** Progress of a "harvest all" run, polled by the popup and the overlay. */
export interface HarvestRun {
  running: boolean;
  done: number;
  total: number;
  current: string | null;
  finishedAt: number | null;
  harvested: number;
  error: string | null;
  /** Whether this run replaced each creator's stored posts as it went. */
  replace: boolean;
}
