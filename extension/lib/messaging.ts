import { browser } from 'wxt/browser';
import type { PostCategory } from '@/lib/ai/prompts';
import type { Backup } from '@/lib/db';
import type {
  CreatePostInput,
  GenerateWeekInput,
  UpdatePostInput,
} from '@/lib/scheduler';
import type {
  CreatorsResponse,
  GenerateResponse,
  HarvestRun,
  IngestPayload,
  IngestResponse,
  InspirationPost,
  PolishPayload,
  PostPayload,
  RecentPayload,
  RecentResponse,
  RemixPayload,
  ReplyPayload,
  ScheduledPost,
  SettingsState,
  VoiceProfile,
  XAccount,
} from '@/lib/types';

// Messages the content script, overlay and popup send to the background service
// worker. The background is the single owner of the OpenAI key and the only
// context that calls OpenAI — x.com's CSP blocks a content-script fetch to
// api.openai.com, and the key must never be readable from a page context.
export type BgRequest =
  | { type: 'settings:get' }
  | { type: 'account:detect' }
  | { type: 'account:connect'; account: XAccount }
  | { type: 'account:disconnect' }
  | { type: 'settings:save'; apiKey?: string; model?: string; baseUrl?: string }
  | { type: 'settings:test'; apiKey?: string; model?: string; baseUrl?: string }
  | { type: 'voice:get' }
  | { type: 'voice:save'; patch: Partial<VoiceProfile> }
  | { type: 'voice:learn'; handle: string | null; posts: string[] }
  | { type: 'voice:learn-from-profile' }
  | { type: 'generate:reply'; payload: ReplyPayload }
  | { type: 'generate:post'; payload: PostPayload }
  | { type: 'generate:polish'; payload: PolishPayload }
  | { type: 'generate:recent'; payload: RecentPayload }
  | { type: 'inspiration:ingest'; payload: IngestPayload }
  | { type: 'inspiration:creators'; fresh?: boolean }
  | { type: 'inspiration:posts' }
  | { type: 'inspiration:remix'; payload: RemixPayload }
  | { type: 'creators:add'; handle: string }
  | { type: 'creators:remove'; handle: string }
  | { type: 'data:export' }
  | { type: 'data:import'; backup: Backup }
  | { type: 'schedule:list' }
  | { type: 'schedule:generate'; input: GenerateWeekInput }
  | { type: 'schedule:create'; input: CreatePostInput }
  | { type: 'schedule:update'; input: UpdatePostInput }
  | { type: 'schedule:generate-one'; category: PostCategory }
  | { type: 'schedule:regenerate'; id: number; category: PostCategory }
  | { type: 'schedule:delete'; id: number }
  | { type: 'schedule:approve'; id: number }
  | { type: 'schedule:unapprove'; id: number }
  | { type: 'schedule:approve-week'; weekStart: string }
  | { type: 'schedule:empty-week'; weekStart: string }
  | { type: 'schedule:publish-now'; id: number }
  | { type: 'harvest:all'; replace?: boolean }
  | { type: 'harvest:status' };

// Messages the background sends INTO a content script. Only the content script
// can touch x.com's DOM, so a background-driven harvest has to ask it to do the
// reading and hand the result back.
export type ContentRequest =
  | { type: 'harvest:run'; handle: string }
  // "Who is logged in here?" — the popup can't read the page itself.
  | { type: 'account:read' }
  // Scroll the user's own profile and hand back their posts, for voice learning.
  | { type: 'learn:scrape'; handle: string }
  // Drive X's composer to publish an approved scheduled post.
  | { type: 'publish:run'; content: string; handle: string };

export interface HarvestResult {
  payload: IngestPayload;
  count: number;
}

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
  getSettings: () => send<SettingsState>({ type: 'settings:get' }),
  /** Read (but don't store) whoever is signed in to an open x.com tab. */
  detectAccount: () => send<XAccount | null>({ type: 'account:detect' }),
  connectAccount: (account: XAccount) =>
    send<SettingsState>({ type: 'account:connect', account }),
  disconnectAccount: () => send<SettingsState>({ type: 'account:disconnect' }),
  learnFromProfile: () => send<LearnResult>({ type: 'voice:learn-from-profile' }),
  saveSettings: (patch: { apiKey?: string; model?: string; baseUrl?: string }) =>
    send<SettingsState>({ type: 'settings:save', ...patch }),
  testKey: (patch: { apiKey?: string; model?: string; baseUrl?: string }) =>
    send<{ model: string }>({ type: 'settings:test', ...patch }),
  getVoice: () => send<VoiceProfile>({ type: 'voice:get' }),
  saveVoice: (patch: Partial<VoiceProfile>) =>
    send<VoiceProfile>({ type: 'voice:save', patch }),
  learnVoice: (handle: string | null, posts: string[]) =>
    send<LearnResult>({ type: 'voice:learn', handle, posts }),
  reply: (payload: ReplyPayload) =>
    send<GenerateResponse>({ type: 'generate:reply', payload }),
  post: (payload: PostPayload) =>
    send<GenerateResponse>({ type: 'generate:post', payload }),
  /** Clean up a draft the user typed themselves, rather than writing a new one. */
  polish: (payload: PolishPayload) =>
    send<GenerateResponse>({ type: 'generate:polish', payload }),
  recent: (payload: RecentPayload) =>
    send<RecentResponse>({ type: 'generate:recent', payload }),
  ingestInspiration: (payload: IngestPayload) =>
    send<IngestResponse>({ type: 'inspiration:ingest', payload }),
  creators: (fresh = false) =>
    send<CreatorsResponse>({ type: 'inspiration:creators', fresh }),
  inspirationPosts: () => send<InspirationPost[]>({ type: 'inspiration:posts' }),
  remix: (payload: RemixPayload) =>
    send<GenerateResponse>({ type: 'inspiration:remix', payload }),
  addCreator: (handle: string) => send<void>({ type: 'creators:add', handle }),
  removeCreator: (handle: string) => send<void>({ type: 'creators:remove', handle }),
  exportData: () => send<Backup>({ type: 'data:export' }),
  importData: (backup: Backup) => send<void>({ type: 'data:import', backup }),
  schedule: () => send<ScheduledPost[]>({ type: 'schedule:list' }),
  generateWeek: (input: GenerateWeekInput) =>
    send<number>({ type: 'schedule:generate', input }),
  createPost: (input: CreatePostInput) =>
    send<number>({ type: 'schedule:create', input }),
  updatePost: (input: UpdatePostInput) =>
    send<ScheduledPost>({ type: 'schedule:update', input }),
  /** Write one post for a category without saving it — the New post modal. */
  generateOnePost: (category: PostCategory) =>
    send<string>({ type: 'schedule:generate-one', category }),
  regeneratePost: (id: number, category: PostCategory) =>
    send<ScheduledPost>({ type: 'schedule:regenerate', id, category }),
  deletePost: (id: number) => send<void>({ type: 'schedule:delete', id }),
  approvePost: (id: number) => send<ScheduledPost>({ type: 'schedule:approve', id }),
  unapprovePost: (id: number) =>
    send<ScheduledPost>({ type: 'schedule:unapprove', id }),
  approveWeek: (weekStart: string) =>
    send<{ approved: number; skipped: number }>({
      type: 'schedule:approve-week',
      weekStart,
    }),
  emptyWeek: (weekStart: string) =>
    send<number>({ type: 'schedule:empty-week', weekStart }),
  publishNow: (id: number) =>
    send<ScheduledPost>({ type: 'schedule:publish-now', id }),
  harvestAll: (replace = false) => send<HarvestRun>({ type: 'harvest:all', replace }),
  harvestStatus: () => send<HarvestRun>({ type: 'harvest:status' }),
};
