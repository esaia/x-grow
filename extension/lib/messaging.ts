import { browser } from 'wxt/browser';
import type {
  AuthState,
  GenerateResponse,
  PostPayload,
  RecentPayload,
  RecentResponse,
  ReplyPayload,
} from '@/lib/types';

// Messages the content script and popup send to the background service worker.
// The background is the single owner of the token and the only context that
// makes cross-origin API calls (content scripts can't, under MV3 CORS rules).
export type BgRequest =
  | { type: 'auth:get' }
  | { type: 'auth:save'; token: string; apiBaseUrl: string }
  | { type: 'auth:logout' }
  | { type: 'generate:reply'; payload: ReplyPayload }
  | { type: 'generate:post'; payload: PostPayload }
  | { type: 'generate:recent'; payload: RecentPayload }
  | { type: 'voice:learn'; handle: string | null; posts: string[] };

export interface LearnResult {
  voice_analysis: string;
  x_handle: string | null;
  count: number;
}

export type BgResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number };

async function send<T>(message: BgRequest): Promise<BgResponse<T>> {
  // When the extension reloads/updates, an already-injected content script gets
  // "orphaned" — its connection to the extension is gone. Handle that (and any
  // transport error) gracefully instead of throwing an uncaught rejection.
  const orphaned: BgResponse<T> = {
    ok: false,
    error: 'X-Grow was updated — refresh this page (⌘/Ctrl+Shift+R) to continue.',
  };

  try {
    if (!browser?.runtime?.id) return orphaned;
    return (await browser.runtime.sendMessage(message)) as BgResponse<T>;
  } catch (error) {
    const msg = (error as Error)?.message ?? '';
    if (/invalidated|Receiving end does not exist|message port closed/i.test(msg)) {
      return orphaned;
    }
    return { ok: false, error: msg || 'Message failed' };
  }
}

// Typed convenience wrappers.
export const bg = {
  getAuth: () => send<AuthState>({ type: 'auth:get' }),
  saveAuth: (token: string, apiBaseUrl: string) =>
    send<AuthState>({ type: 'auth:save', token, apiBaseUrl }),
  logout: () => send<AuthState>({ type: 'auth:logout' }),
  reply: (payload: ReplyPayload) =>
    send<GenerateResponse>({ type: 'generate:reply', payload }),
  post: (payload: PostPayload) =>
    send<GenerateResponse>({ type: 'generate:post', payload }),
  recent: (payload: RecentPayload) =>
    send<RecentResponse>({ type: 'generate:recent', payload }),
  learnVoice: (handle: string | null, posts: string[]) =>
    send<LearnResult>({ type: 'voice:learn', handle, posts }),
};
