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

export interface AuthState {
  connected: boolean;
  apiBaseUrl: string;
  me: MeResponse | null;
}
