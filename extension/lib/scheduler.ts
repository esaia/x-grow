import { generateOptions } from '@/lib/ai/openai';
import {
  POST_CATEGORIES,
  systemPrompt,
  weeklyBatchPrompt,
  type PostCategory,
} from '@/lib/ai/prompts';
import {
  createScheduledPost,
  getScheduledPost,
  getVoiceProfile,
  listScheduledPosts,
  logGeneration,
  recentPostContents,
  replaceWeekDrafts,
  updateScheduledPost,
  type NewScheduledPost,
} from '@/lib/db';
import { getOpenAiConfig } from '@/lib/storage';
import { addDays, localTimezone, naive, realInstant } from '@/lib/time';
import type { ScheduledPost } from '@/lib/types';

/**
 * The weekly schedule: generating a week of drafts, moving posts around, and
 * the rules about when an approved post falls back to draft.
 *
 * Ported from the platform's ScheduleController, minus everything that existed
 * only because posts could target several accounts on two networks.
 */

/** Minimum spacing between two posts on the same day. */
const MIN_GAP_MINUTES = 60;

/** Generating a week is one call, so it needs room; ~200 tokens per post. */
const MAX_BATCH_TOKENS = 4096;

/** How many recent posts are fed back in to stop the model repeating itself. */
const RECENT_CONTEXT = 40;

export interface GenerateWeekInput {
  weekStart: string;
  /** "HH:MM" bounds the random times are drawn from. */
  rangeStart: string;
  rangeEnd: string;
  perDay: number;
  categories: PostCategory[];
  timezone?: string;
}

/**
 * Fill a week with drafts.
 *
 * Deliberately **one** OpenAI call for the whole week rather than one per slot:
 * a 3-a-day week is 21 posts, and 21 sequential HTTP round trips inside a
 * single user action is a minute of staring at a spinner. The batch prompt
 * pins each slot to a category so the week still varies.
 */
export async function generateWeek(input: GenerateWeekInput): Promise<number> {
  const categories =
    input.categories.length > 0
      ? input.categories
      : (Object.keys(POST_CATEGORIES) as PostCategory[]);

  const perDay = Math.min(Math.max(input.perDay, 1), 6);
  const total = perDay * 7;

  const startMinutes = toMinutes(input.rangeStart);
  const endMinutes = toMinutes(input.rangeEnd);

  if (endMinutes <= startMinutes) {
    throw new Error('The end time has to be after the start time.');
  }

  // Cycle the chosen categories across every slot, so a 3-category week
  // alternates rather than clumping.
  const slots: PostCategory[] = Array.from(
    { length: total },
    (_, i) => categories[i % categories.length],
  );

  const [config, profile, recent] = await Promise.all([
    getOpenAiConfig(),
    getVoiceProfile(),
    recentPostContents(RECENT_CONTEXT),
  ]);

  const result = await generateOptions(
    config,
    systemPrompt(profile),
    weeklyBatchPrompt(slots, recent),
    total,
    Math.min(MAX_BATCH_TOKENS, 200 * total),
  );

  if (result.options.length === 0) {
    throw new Error('The model returned nothing. Try again.');
  }

  const generationId = await logGeneration({
    type: 'post',
    input_context: null,
    meta: { weekly_schedule: true },
    output: result.options,
    model: result.model,
    tokens_in: result.input_tokens,
    tokens_out: result.output_tokens,
  });

  const timezone = input.timezone ?? localTimezone();
  const posts: NewScheduledPost[] = [];
  let taken = 0;

  for (let day = 0; day < 7; day++) {
    const date = addDays(input.weekStart, day);
    const times = randomTimesInRange(startMinutes, endMinutes, perDay);

    for (const minutes of times) {
      // The model may return fewer options than asked for; stop rather than
      // creating empty posts.
      if (taken >= result.options.length) break;

      posts.push({
        content: result.options[taken],
        category: slots[taken],
        status: 'draft',
        error: null,
        scheduled_at: naive(date, fromMinutes(minutes)),
        timezone,
        posted_at: null,
        external_post_id: null,
        generation_id: generationId,
      });

      taken++;
    }
  }

  await replaceWeekDrafts(input.weekStart, addDays(input.weekStart, 7), posts);

  return posts.length;
}

/**
 * `count` times inside [start, end], spread out and jittered.
 *
 * Posts want a real gap between them, but a fixed grid ("always 9:00, 13:00,
 * 17:00") reads as automation. So each slot gets a random offset within the
 * slack the range leaves over, then the minimum gap is added back. If the range
 * is too tight for a 60-minute gap the gap shrinks rather than the call
 * failing — a user picking a 2-hour window for 3 posts means it.
 */
export function randomTimesInRange(
  start: number,
  end: number,
  count: number,
): number[] {
  let gap = MIN_GAP_MINUTES;

  while (gap > 15 && start + gap * (count - 1) > end) {
    gap -= 15;
  }

  const slack = Math.max(0, end - start - gap * (count - 1));
  const steps = Math.floor(slack / 15);

  const offsets = Array.from({ length: count }, () =>
    steps > 0 ? Math.floor(Math.random() * (steps + 1)) : 0,
  ).sort((a, b) => a - b);

  return offsets.map((offset, i) => start + offset * 15 + i * gap);
}

/** Would this post collide with another at the same instant? */
export async function hasConflict(
  scheduledAt: string,
  ignoreId?: number,
): Promise<boolean> {
  const posts = await listScheduledPosts();

  return posts.some(
    (post) => post.id !== ignoreId && post.scheduled_at === scheduledAt,
  );
}

export interface CreatePostInput {
  content: string;
  category: PostCategory | null;
  date: string;
  time: string;
  timezone?: string;
}

export async function createPost(input: CreatePostInput): Promise<number> {
  const scheduledAt = naive(input.date, input.time);

  if (await hasConflict(scheduledAt)) {
    throw new Error('Another post is already scheduled for that time.');
  }

  return createScheduledPost({
    content: input.content,
    category: input.category,
    status: 'draft',
    error: null,
    scheduled_at: scheduledAt,
    timezone: input.timezone ?? localTimezone(),
    posted_at: null,
    external_post_id: null,
    generation_id: null,
  });
}

export interface UpdatePostInput {
  id: number;
  content?: string;
  category?: PostCategory | null;
  date?: string;
  time?: string;
  timezone?: string;
}

/**
 * Edit a post.
 *
 * Editing the content or category of an **approved** post drops it back to
 * draft: the user approved a specific piece of text for automatic publishing,
 * and silently auto-posting different text would break that. Moving it in time
 * is not a re-approval — the same text still goes out.
 */
export async function updatePost(
  input: UpdatePostInput,
): Promise<ScheduledPost> {
  const existing = await getScheduledPost(input.id);

  if (!existing) throw new Error('That post no longer exists.');

  const scheduledAt =
    input.date || input.time
      ? naive(
          input.date ?? existing.scheduled_at.slice(0, 10),
          input.time ?? existing.scheduled_at.slice(11, 16),
        )
      : existing.scheduled_at;

  if (
    scheduledAt !== existing.scheduled_at &&
    (await hasConflict(scheduledAt, input.id))
  ) {
    throw new Error('Another post is already scheduled for that time.');
  }

  const contentChanged =
    input.content !== undefined && input.content !== existing.content;
  const categoryChanged =
    input.category !== undefined && input.category !== existing.category;

  const patch: Partial<ScheduledPost> = {
    content: input.content ?? existing.content,
    category: input.category === undefined ? existing.category : input.category,
    scheduled_at: scheduledAt,
    timezone: input.timezone ?? existing.timezone,
  };

  if (existing.status === 'scheduled' && (contentChanged || categoryChanged)) {
    patch.status = 'draft';
  }

  const updated = await updateScheduledPost(input.id, patch);

  if (!updated) throw new Error('That post no longer exists.');

  return updated;
}

/**
 * Write a single post for one category, without saving anything.
 *
 * Used by the "New post" modal so a slot can be filled by the AI before it
 * exists as a row. Reuses the weekly batch prompt with a one-element list, so a
 * hand-added post reads exactly like a generated week's.
 */
export async function generateSinglePost(
  category: PostCategory,
): Promise<string> {
  const [config, profile, recent] = await Promise.all([
    getOpenAiConfig(),
    getVoiceProfile(),
    recentPostContents(RECENT_CONTEXT),
  ]);

  const result = await generateOptions(
    config,
    systemPrompt(profile),
    weeklyBatchPrompt([category], recent),
    1,
    512,
  );

  if (result.options.length === 0) {
    throw new Error('The model returned nothing. Try again.');
  }

  await logGeneration({
    type: 'post',
    input_context: null,
    meta: { weekly_schedule: true, category },
    output: result.options,
    model: result.model,
    tokens_in: result.input_tokens,
    tokens_out: result.output_tokens,
  });

  return result.options[0];
}

/**
 * Rewrite one post's content in the same category, reusing the weekly batch
 * prompt with a single-element list. Always returns to draft, for the same
 * reason an edit does.
 */
export async function regeneratePost(
  id: number,
  category: PostCategory,
): Promise<ScheduledPost> {
  const existing = await getScheduledPost(id);

  if (!existing) throw new Error('That post no longer exists.');

  const [config, profile, recent] = await Promise.all([
    getOpenAiConfig(),
    getVoiceProfile(),
    recentPostContents(RECENT_CONTEXT),
  ]);

  const result = await generateOptions(
    config,
    systemPrompt(profile),
    weeklyBatchPrompt([category], recent),
    1,
    512,
  );

  if (result.options.length === 0) {
    throw new Error('The model returned nothing. Try again.');
  }

  const generationId = await logGeneration({
    type: 'post',
    input_context: null,
    meta: { weekly_schedule: true, regenerate: true, category },
    output: result.options,
    model: result.model,
    tokens_in: result.input_tokens,
    tokens_out: result.output_tokens,
  });

  const updated = await updateScheduledPost(id, {
    content: result.options[0],
    category,
    status: 'draft',
    error: null,
    generation_id: generationId,
  });

  if (!updated) throw new Error('That post no longer exists.');

  return updated;
}

/**
 * Approve a draft for automatic publishing. This is the single point where the
 * user opts a specific piece of text into auto-posting, so it is also where the
 * "not in the past" guard belongs.
 */
export async function approvePost(id: number): Promise<ScheduledPost> {
  const post = await getScheduledPost(id);

  if (!post) throw new Error('That post no longer exists.');

  if (realInstant(post.scheduled_at, post.timezone) <= Date.now()) {
    throw new Error('That time has already passed. Move it first.');
  }

  const updated = await updateScheduledPost(id, {
    status: 'scheduled',
    error: null,
  });

  if (!updated) throw new Error('That post no longer exists.');

  return updated;
}

export async function unapprovePost(id: number): Promise<ScheduledPost> {
  const updated = await updateScheduledPost(id, { status: 'draft' });

  if (!updated) throw new Error('That post no longer exists.');

  return updated;
}

/** Approve every future draft in a week. Returns what happened, honestly. */
export async function approveWeek(
  weekStart: string,
): Promise<{ approved: number; skipped: number }> {
  const end = addDays(weekStart, 7);
  const posts = await listScheduledPosts();
  const now = Date.now();

  let approved = 0;
  let skipped = 0;

  for (const post of posts) {
    if (
      post.status !== 'draft' ||
      post.scheduled_at < weekStart ||
      post.scheduled_at >= end
    ) {
      continue;
    }

    if (realInstant(post.scheduled_at, post.timezone) <= now) {
      skipped++;
      continue;
    }

    await updateScheduledPost(post.id, { status: 'scheduled', error: null });
    approved++;
  }

  return { approved, skipped };
}

/** Delete a week's drafts. Approved, posted and failed posts are left alone. */
export async function emptyWeek(weekStart: string): Promise<number> {
  const end = addDays(weekStart, 7);
  const posts = await listScheduledPosts();

  const removed = posts.filter(
    (post) =>
      post.status === 'draft' &&
      post.scheduled_at >= weekStart &&
      post.scheduled_at < end,
  ).length;

  await replaceWeekDrafts(weekStart, end, []);

  return removed;
}

function toMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);

  return h * 60 + (m || 0);
}

function fromMinutes(total: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(total)));
  const pad = (n: number) => String(n).padStart(2, '0');

  return `${pad(Math.floor(clamped / 60))}:${pad(clamped % 60)}`;
}
