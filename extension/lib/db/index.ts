import { all, req, run, STORE } from '@/lib/db/idb';
import { rescore } from '@/lib/scoring';
import {
  emptyVoiceProfile,
  type Creator,
  type CreatorSummary,
  type Generation,
  type GenerationMeta,
  type GenerationType,
  type IngestPayload,
  type IngestResponse,
  type InspirationPost,
  type PostStatus,
  type ScheduledPost,
  type VoiceProfile,
} from '@/lib/types';

/**
 * Typed repositories over IndexedDB. Everything the Laravel controllers used to
 * do against MySQL happens here instead.
 */

const PROFILE_KEY = 1;

function now(): string {
  return new Date().toISOString();
}

/* ------------------------------------------------------------------ voice */

export async function getVoiceProfile(): Promise<VoiceProfile> {
  const stored = await run(STORE.voiceProfile, 'readonly', (tx) =>
    req<VoiceProfile | undefined>(
      tx.objectStore(STORE.voiceProfile).get(PROFILE_KEY),
    ),
  );

  // Merge over the defaults so a profile written by an older build still has
  // every field the prompt builder reads.
  return { ...emptyVoiceProfile(), ...(stored ?? {}) };
}

export async function saveVoiceProfile(
  patch: Partial<VoiceProfile>,
): Promise<VoiceProfile> {
  const current = await getVoiceProfile();
  const next: VoiceProfile = { ...current, ...patch };

  await run(STORE.voiceProfile, 'readwrite', (tx) =>
    req(tx.objectStore(STORE.voiceProfile).put(next, PROFILE_KEY)),
  );

  return next;
}

/* ------------------------------------------------------------ generations */

export interface NewGeneration {
  type: GenerationType;
  input_context: string | null;
  meta: GenerationMeta | null;
  output: string[];
  model: string | null;
  tokens_in: number;
  tokens_out: number;
}

export async function logGeneration(input: NewGeneration): Promise<number> {
  const record = { ...input, created_at: now() };

  const key = await run(STORE.generations, 'readwrite', (tx) =>
    req(tx.objectStore(STORE.generations).add(record)),
  );

  return Number(key);
}

/**
 * Past generations for the exact same input, newest first. Replaces the
 * platform's POST /generate/recent — it lets the panel re-surface options the
 * user already paid for instead of calling OpenAI again.
 */
export async function recentGenerations(
  type: GenerationType,
  inputContext: string,
  limit = 20,
): Promise<Generation[]> {
  const matches = await run(STORE.generations, 'readonly', (tx) =>
    all<Generation>(tx.objectStore(STORE.generations).index('input_context')),
  );

  return matches
    .filter((g) => g.type === type && g.input_context === inputContext)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit);
}

export async function listGenerations(limit = 100): Promise<Generation[]> {
  const rows = await run(STORE.generations, 'readonly', (tx) =>
    all<Generation>(tx.objectStore(STORE.generations)),
  );

  return rows.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
}

/** Generation counts for today and all time — the popup's usage display. */
export async function generationUsage(): Promise<{
  today: number;
  total: number;
}> {
  const rows = await run(STORE.generations, 'readonly', (tx) =>
    all<Generation>(tx.objectStore(STORE.generations)),
  );

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const cutoff = startOfDay.toISOString();

  return {
    today: rows.filter((g) => g.created_at >= cutoff).length,
    total: rows.length,
  };
}

/* --------------------------------------------------------- scheduled posts */

export type NewScheduledPost = Omit<
  ScheduledPost,
  'id' | 'created_at' | 'updated_at'
>;

export async function createScheduledPost(
  input: NewScheduledPost,
): Promise<number> {
  const timestamp = now();
  const key = await run(STORE.scheduledPosts, 'readwrite', (tx) =>
    req(
      tx
        .objectStore(STORE.scheduledPosts)
        .add({ ...input, created_at: timestamp, updated_at: timestamp }),
    ),
  );

  return Number(key);
}

export async function listScheduledPosts(): Promise<ScheduledPost[]> {
  const rows = await run(STORE.scheduledPosts, 'readonly', (tx) =>
    all<ScheduledPost>(tx.objectStore(STORE.scheduledPosts)),
  );

  return rows.sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
}

export async function getScheduledPost(
  id: number,
): Promise<ScheduledPost | undefined> {
  return run(STORE.scheduledPosts, 'readonly', (tx) =>
    req<ScheduledPost | undefined>(tx.objectStore(STORE.scheduledPosts).get(id)),
  );
}

export async function updateScheduledPost(
  id: number,
  patch: Partial<ScheduledPost>,
): Promise<ScheduledPost | undefined> {
  return run(STORE.scheduledPosts, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE.scheduledPosts);
    const existing = await req<ScheduledPost | undefined>(store.get(id));

    if (!existing) {
      return undefined;
    }

    const next: ScheduledPost = { ...existing, ...patch, id, updated_at: now() };

    await req(store.put(next));

    return next;
  });
}

export async function deleteScheduledPost(id: number): Promise<void> {
  await run(STORE.scheduledPosts, 'readwrite', (tx) =>
    req(tx.objectStore(STORE.scheduledPosts).delete(id)),
  );
}

/** Posts in a given status, cheapest path for the publish tick. */
export async function scheduledPostsByStatus(
  status: PostStatus,
): Promise<ScheduledPost[]> {
  return run(STORE.scheduledPosts, 'readonly', (tx) =>
    all<ScheduledPost>(
      tx.objectStore(STORE.scheduledPosts).index('status'),
    ),
  ).then((rows) => rows.filter((row) => row.status === status));
}

/**
 * Replace one week's drafts in a single transaction — the port of
 * ScheduleController::generate()'s delete-then-insert. Posts the user already
 * approved (anything not `draft`) survive.
 */
export async function replaceWeekDrafts(
  from: string,
  to: string,
  posts: NewScheduledPost[],
): Promise<void> {
  await run(STORE.scheduledPosts, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE.scheduledPosts);
    const existing = await all<ScheduledPost>(store);

    for (const post of existing) {
      if (
        post.status === 'draft' &&
        post.scheduled_at >= from &&
        post.scheduled_at < to
      ) {
        await req(store.delete(post.id));
      }
    }

    const timestamp = now();

    for (const post of posts) {
      await req(store.add({ ...post, created_at: timestamp, updated_at: timestamp }));
    }
  });
}

/**
 * Content of the most recent posts, fed back into the weekly prompt so the
 * model stops rewriting the same three ideas. Ported from recentPostContents().
 */
export async function recentPostContents(limit = 40): Promise<string[]> {
  const rows = await listScheduledPosts();

  return rows
    .sort((a, b) => b.scheduled_at.localeCompare(a.scheduled_at))
    .slice(0, limit)
    .map((post) => post.content);
}

/* ---------------------------------------------------------- inspiration */

export async function listCreators(): Promise<CreatorSummary[]> {
  return run([STORE.creators, STORE.inspirationPosts], 'readonly', async (tx) => {
    const creators = await all<Creator>(tx.objectStore(STORE.creators));
    const posts = await all<InspirationPost>(
      tx.objectStore(STORE.inspirationPosts),
    );

    const counts = new Map<string, number>();

    for (const post of posts) {
      counts.set(post.username, (counts.get(post.username) ?? 0) + 1);
    }

    return creators
      .map((creator) => ({
        ...creator,
        posts_count: counts.get(creator.username) ?? 0,
      }))
      .sort((a, b) => a.username.localeCompare(b.username));
  });
}

export async function addCreator(handle: string): Promise<Creator> {
  const username = normalizeHandle(handle);

  return run(STORE.creators, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE.creators);
    const existing = await req<Creator | undefined>(store.get(username));

    if (existing) {
      return existing;
    }

    const creator: Creator = {
      username,
      name: null,
      avatar_url: null,
      followers_count: null,
      last_scanned_at: null,
    };

    await req(store.add(creator));

    return creator;
  });
}

export async function deleteCreator(handle: string): Promise<void> {
  const username = normalizeHandle(handle);

  await run([STORE.creators, STORE.inspirationPosts], 'readwrite', async (tx) => {
    await req(tx.objectStore(STORE.creators).delete(username));

    const index = tx.objectStore(STORE.inspirationPosts).index('username');
    const keys = await req(index.getAllKeys(username));

    for (const key of keys) {
      await req(tx.objectStore(STORE.inspirationPosts).delete(key));
    }
  });
}

export async function listInspirationPosts(): Promise<InspirationPost[]> {
  const rows = await run(STORE.inspirationPosts, 'readonly', (tx) =>
    all<InspirationPost>(tx.objectStore(STORE.inspirationPosts)),
  );

  return rows.sort((a, b) => b.baseline_multiplier - a.baseline_multiplier);
}

/**
 * Store a harvested batch. Ported from InspirationIngestController::store().
 *
 * Upserts by default, and that default is load-bearing: a harvest only ever
 * sees whatever the page had loaded, so replacing on every run would shrink the
 * board to one screenful. `replace` is set solely by an explicit "Update data"
 * refresh, and is applied inside the transaction (never as an upfront wipe) so
 * a run that dies halfway cannot leave the creator empty.
 */
export async function ingestInspiration(
  payload: IngestPayload,
): Promise<IngestResponse> {
  const username = normalizeHandle(payload.handle);

  const stored = await run(
    [STORE.creators, STORE.inspirationPosts],
    'readwrite',
    async (tx) => {
      const creators = tx.objectStore(STORE.creators);
      const postsStore = tx.objectStore(STORE.inspirationPosts);

      const existingCreator = await req<Creator | undefined>(
        creators.get(username),
      );

      // Only overwrite profile fields the harvest actually saw.
      const creator: Creator = {
        username,
        name: payload.profile.name ?? existingCreator?.name ?? null,
        avatar_url:
          payload.profile.avatar_url ?? existingCreator?.avatar_url ?? null,
        followers_count:
          payload.profile.followers_count ??
          existingCreator?.followers_count ??
          null,
        last_scanned_at: now(),
      };

      await req(creators.put(creator));

      const index = postsStore.index('username');
      const previous = await all<InspirationPost>(index);
      const byId = new Map<string, InspirationPost>();

      if (!payload.replace) {
        for (const post of previous.filter((p) => p.username === username)) {
          byId.set(post.x_tweet_id, post);
        }
      }

      for (const incoming of payload.posts) {
        byId.set(incoming.x_tweet_id, {
          username,
          x_tweet_id: incoming.x_tweet_id,
          content: incoming.content,
          url:
            incoming.url ||
            `https://x.com/${username}/status/${incoming.x_tweet_id}`,
          posted_at: incoming.posted_at,
          metrics: incoming.metrics,
          baseline_multiplier: 0,
        });
      }

      const kept = rescore([...byId.values()]);
      const keptIds = new Set(kept.map((post) => post.x_tweet_id));

      // Drop anything trimmed away, or everything prior on a replace run.
      for (const post of previous) {
        if (post.username === username && !keptIds.has(post.x_tweet_id)) {
          await req(postsStore.delete([post.username, post.x_tweet_id]));
        }
      }

      for (const post of kept) {
        await req(postsStore.put(post));
      }

      return kept.length;
    },
  );

  return { username, received: payload.posts.length, stored };
}

export function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@/, '').toLowerCase();
}

/* --------------------------------------------------------- backup / wipe */

export interface Backup {
  version: number;
  exported_at: string;
  voiceProfile: VoiceProfile;
  generations: Generation[];
  scheduledPosts: ScheduledPost[];
  creators: Creator[];
  inspirationPosts: InspirationPost[];
}

/**
 * With no server there is no other backup, so this ships in the first release
 * rather than "later".
 */
export async function exportAll(): Promise<Backup> {
  const [voiceProfile, generations, scheduledPosts, creators, inspirationPosts] =
    await Promise.all([
      getVoiceProfile(),
      listGenerations(Number.MAX_SAFE_INTEGER),
      listScheduledPosts(),
      listCreators(),
      listInspirationPosts(),
    ]);

  return {
    version: 1,
    exported_at: now(),
    voiceProfile,
    generations,
    scheduledPosts,
    creators: creators.map(({ posts_count: _count, ...creator }) => creator),
    inspirationPosts,
  };
}

export async function importAll(backup: Backup): Promise<void> {
  await run(
    [
      STORE.voiceProfile,
      STORE.generations,
      STORE.scheduledPosts,
      STORE.creators,
      STORE.inspirationPosts,
    ],
    'readwrite',
    async (tx) => {
      for (const name of [
        STORE.voiceProfile,
        STORE.generations,
        STORE.scheduledPosts,
        STORE.creators,
        STORE.inspirationPosts,
      ]) {
        await req(tx.objectStore(name).clear());
      }

      await req(
        tx
          .objectStore(STORE.voiceProfile)
          .put({ ...emptyVoiceProfile(), ...backup.voiceProfile }, PROFILE_KEY),
      );

      for (const row of backup.generations ?? []) {
        await req(tx.objectStore(STORE.generations).put(row));
      }

      for (const row of backup.scheduledPosts ?? []) {
        await req(tx.objectStore(STORE.scheduledPosts).put(row));
      }

      for (const row of backup.creators ?? []) {
        await req(tx.objectStore(STORE.creators).put(row));
      }

      for (const row of backup.inspirationPosts ?? []) {
        await req(tx.objectStore(STORE.inspirationPosts).put(row));
      }
    },
  );
}
