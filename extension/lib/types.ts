export interface VoiceProfile {
  tone: string;
  sample_posts: string | null;
  dos: string | null;
  donts: string | null;
  bio_context: string | null;
}

export interface MeResponse {
  user: { id: number; name: string; email: string };
  voice_profile: VoiceProfile | null;
  usage: { today: number; total: number };
  options: { tones: string[]; post_formats: string[] };
}

export interface GenerateResponse {
  generation_id: number;
  type: 'reply' | 'post';
  options: string[];
  model: string;
}

export interface RecentPayload {
  type: 'reply' | 'post';
  input_context: string;
}

export interface RecentGeneration {
  id: number;
  type: 'reply' | 'post';
  options: string[];
  meta: { tone?: string; has_thread?: boolean; format?: string } | null;
  model: string | null;
  created_at: string | null;
}

export interface RecentResponse {
  generations: RecentGeneration[];
}

export interface ReplyPayload {
  tweet: string;
  thread_context?: string;
  tone?: string;
  count?: number;
}

export interface PostPayload {
  topic: string;
  format?: 'single' | 'hook' | 'thread';
  tone?: string;
  count?: number;
}

export interface IngestPayload {
  handle: string;
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
    metrics: { like: number; reply: number; retweet: number; quote: number };
  }[];
}

export interface TrackedCreator {
  username: string;
  posts_count: number;
  last_scanned_at: string | null;
}

export interface CreatorsResponse {
  creators: TrackedCreator[];
}

/** Shape of the {ok, data|error} envelope every messaging call replies with. */
export type BgResponseLike<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/** Progress of a "harvest all" run, polled by the popup. */
export interface HarvestRun {
  running: boolean;
  done: number;
  total: number;
  current: string | null;
  finishedAt: number | null;
  harvested: number;
  error: string | null;
}

export interface IngestResponse {
  creator: { id: number; username: string; name: string | null };
  received: number;
  stored: number;
}

export interface AuthState {
  connected: boolean;
  apiBaseUrl: string;
  me: MeResponse | null;
}
