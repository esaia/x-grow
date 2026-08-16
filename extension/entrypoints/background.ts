import { browser } from 'wxt/browser';
import { generateOptions, message as askModel, OpenAiError } from '@/lib/ai/openai';
import {
  analyzePrompt,
  analyzeSystemPrompt,
  HUMAN_SAMPLING,
  inspirationPrompt,
  postPrompt,
  replyPrompt,
  systemPrompt,
} from '@/lib/ai/prompts';
import { rankReplies, repairPrompt, screenReplies, setProblems } from '@/lib/ai/quality';
import { applyStyle, measureStyle } from '@/lib/ai/style';
import { REPLY_OPTION_COUNT } from '@/lib/config';
import {
  addCreator,
  deleteCreator,
  deleteScheduledPost,
  exportAll,
  generationUsage,
  getScheduledPost,
  getVoiceProfile,
  importAll,
  ingestInspiration,
  listCreators,
  listInspirationPosts,
  listScheduledPosts,
  logGeneration,
  recentGenerations,
  saveVoiceProfile,
} from '@/lib/db';
import type { BgRequest, ContentRequest, HarvestResult, LearnResult } from '@/lib/messaging';
import { ALARM_NAME, publishDue, publishNow, type PublishDeps } from '@/lib/publisher';
import {
  approvePost,
  approveWeek,
  createPost,
  emptyWeek,
  generateSinglePost,
  generateWeek,
  regeneratePost,
  unapprovePost,
  updatePost,
} from '@/lib/scheduler';
import { accountItem, getOpenAiConfig, setOpenAiConfig } from '@/lib/storage';
import type { XAccount } from '@/lib/xdom';
import type {
  BgResponseLike,
  CreatorsResponse,
  GenerateResponse,
  HarvestRun,
  PostPayload,
  RemixPayload,
  ReplyPayload,
  SettingsState,
} from '@/lib/types';

// ---------------------------------------------------------------------------
// The background worker owns the OpenAI key and every write to IndexedDB.
// Nothing here talks to a server of ours — there isn't one anymore.
// ---------------------------------------------------------------------------

/** Token budgets, ported from the platform's GenerationController. */
const REPLY_MAX_TOKENS = 1536;

/**
 * For replies we ask the model for more options than the panel shows, then
 * screen and rank down to `count`. With an exact-count ask, every option the
 * screener rejects is a slot the user simply loses — which is what made
 * regenerating feel like a slot machine.
 *
 * Kept at roughly 1.6x `REPLY_OPTION_COUNT`: enough headroom that a normal
 * batch survives screening without the repair call, without paying for
 * candidates nobody sees. These are the tokens the user waits on, so this is
 * not free — over-asking further trades spinner time for headroom we don't need.
 */
const REPLY_CANDIDATES = 5;
const POST_MAX_TOKENS = 1024;
const THREAD_MAX_TOKENS = 2048;
const LEARN_MAX_TOKENS = 600;

async function settingsState(): Promise<SettingsState> {
  const [config, usage, voiceProfile, account] = await Promise.all([
    getOpenAiConfig(),
    generationUsage(),
    getVoiceProfile(),
    accountItem.getValue(),
  ]);

  return {
    account,
    // Deliberately only the presence of a key, never the key itself.
    hasKey: config.apiKey.trim() !== '',
    model: config.model,
    baseUrl: config.baseUrl,
    usage,
    voiceProfile,
  };
}

/**
 * Ask an open x.com tab who is signed in. The popup runs in its own document
 * and can't read the page, so detection has to be relayed through a tab.
 */
async function detectAccount(): Promise<XAccount | null> {
  const tabs = await browser.tabs.query({ url: 'https://x.com/*' });

  for (const tab of tabs) {
    if (tab.id === undefined) continue;

    try {
      const res = (await browser.tabs.sendMessage(tab.id, {
        type: 'account:read',
      } satisfies ContentRequest)) as BgResponseLike<XAccount | null>;

      if (res?.ok && res.data) return res.data;
    } catch {
      // Tab hasn't loaded the content script (or was closed) — try the next.
    }
  }

  return null;
}

async function connectAccount(account: XAccount): Promise<SettingsState> {
  await accountItem.setValue(account);

  // Prefill the voice profile's handle, so "Learn my voice" and the prompt's
  // owner context are wired up without the user retyping what we already know.
  const profile = await getVoiceProfile();

  if (profile.x_handle !== account.handle) {
    await saveVoiceProfile({ x_handle: account.handle });
  }

  return settingsState();
}

async function generate(
  type: 'reply' | 'post',
  payload: ReplyPayload | PostPayload,
): Promise<GenerateResponse> {
  const [config, profile] = await Promise.all([getOpenAiConfig(), getVoiceProfile()]);

  const system = systemPrompt(profile);

  let prompt: string;
  let maxTokens: number;
  let inputContext: string;
  let meta: Record<string, unknown>;

  if (type === 'reply') {
    const reply = payload as ReplyPayload;

    prompt = replyPrompt(reply.tweet, reply.thread_context ?? null, reply.tone ?? null);
    maxTokens = REPLY_MAX_TOKENS;
    inputContext = reply.tweet;
    meta = { tone: reply.tone ?? profile.tone, has_thread: Boolean(reply.thread_context) };
  } else {
    const post = payload as PostPayload;
    const format = post.format ?? 'single';

    prompt = postPrompt(post.topic, format, post.tone ?? null);
    maxTokens = format === 'thread' ? THREAD_MAX_TOKENS : POST_MAX_TOKENS;
    inputContext = post.topic;
    meta = { tone: post.tone ?? profile.tone, format };
  }

  const count = Math.min(Math.max(payload.count ?? REPLY_OPTION_COUNT, 1), 5);
  const ask = type === 'reply' ? Math.max(count, REPLY_CANDIDATES) : count;

  const result = await generateOptions(
    config,
    system,
    prompt,
    ask,
    maxTokens,
    HUMAN_SAMPLING,
  );

  let options = result.options;

  if (type === 'reply') {
    options = await screenedReplies(
      config,
      system,
      prompt,
      (payload as ReplyPayload).tweet,
      result.options,
      count,
      maxTokens,
    );

    // The prompt already states these habits; enforcing them in code is what
    // keeps a capitalized, full-stopped model sentence from reading as edited
    // prose next to the owner's real posts.
    const signals = measureStyle(profile.sample_posts, profile.learned_posts);

    if (signals) {
      options = options.map((option) => applyStyle(option, signals));
    }
  }

  const generationId = await logGeneration({
    type,
    input_context: inputContext,
    meta,
    output: options,
    model: result.model,
    tokens_in: result.input_tokens,
    tokens_out: result.output_tokens,
  });

  return {
    generation_id: generationId,
    type,
    options,
    model: result.model,
  };
}

/**
 * Enforce the reply rules, repairing once if too many options were thrown out.
 *
 * Capped at a single repair call: two round trips is already the limit of what
 * someone will wait for mid-scroll, and a model that ignores the rules twice
 * will not obey on the third ask. If the repair also comes back thin, we return
 * what we have rather than showing an empty panel — a mediocre reply the user
 * can edit beats no reply at all.
 */
async function screenedReplies(
  config: Awaited<ReturnType<typeof getOpenAiConfig>>,
  system: string,
  prompt: string,
  tweet: string,
  options: string[],
  count: number,
  maxTokens: number,
): Promise<string[]> {
  const first = screenReplies(options, tweet);

  // We asked for more candidates than we show, so rank the survivors by
  // human-ness and take the top `count` — the set the user actually sees.
  const pick = rankReplies(first.kept).slice(0, count);

  // Two ways a batch fails: too many individual options broke a rule, or the
  // set as a whole reads as machine output (all third-person, all one length)
  // even though each option passed on its own.
  const problems = setProblems(pick, tweet);
  const thin = pick.length < Math.min(3, count);

  if (!thin && problems.length === 0) {
    return pick.length > 0 ? pick : options.slice(0, count);
  }

  // A set-level failure needs a fresh batch, not a top-up: keeping the old
  // options would preserve the very sameness we are trying to break.
  const keep = problems.length > 0 ? [] : pick;
  const needed = count - keep.length;

  try {
    const repair = await generateOptions(
      config,
      system,
      `${prompt}

${repairPrompt(first.rejected, needed + 2, problems)}`,
      // Over-ask the repair too — its survivors are all we have left.
      needed + 2,
      maxTokens,
      HUMAN_SAMPLING,
    );

    const second = screenReplies(repair.options, tweet);
    const merged = [...keep, ...rankReplies(second.kept)].slice(0, count);

    return merged.length > 0
      ? merged
      : [...keep, ...repair.options].slice(0, count);
  } catch (error) {
    console.warn('[X-Grow] Reply repair pass failed', error);

    return pick.length > 0 ? pick : options.slice(0, count);
  }
}

async function learnVoice(
  handle: string | null,
  posts: string[],
): Promise<LearnResult> {
  // Dedupe and trim exactly as VoiceProfileController::learn() did.
  const cleaned = [...new Set(posts.map((post) => post.trim()).filter(Boolean))].slice(
    0,
    60,
  );

  if (cleaned.length === 0) {
    throw new OpenAiError('No posts found to learn from.', 422);
  }

  const config = await getOpenAiConfig();

  const result = await askModel(
    config,
    analyzeSystemPrompt(),
    analyzePrompt(cleaned),
    LEARN_MAX_TOKENS,
  );

  await saveVoiceProfile({
    x_handle: handle?.replace(/^@/, '') ?? null,
    voice_analysis: result.text,
    learned_posts: cleaned.join('\n'),
    voice_learned_at: new Date().toISOString(),
  });

  return {
    voice_analysis: result.text,
    x_handle: handle,
    count: cleaned.length,
  };
}

/**
 * "Remix this post": take a viral post from a tracked creator and rewrite it in
 * the owner's voice. The source is recorded on the generation so History can
 * show where an idea came from — the post itself never mentions it.
 */
async function remix(
  payload: RemixPayload,
): Promise<GenerateResponse> {
  const [config, profile] = await Promise.all([
    getOpenAiConfig(),
    getVoiceProfile(),
  ]);

  const result = await generateOptions(
    config,
    systemPrompt(profile),
    inspirationPrompt(payload.content, payload.closeness, payload.instructions ?? null),
    3,
    512,
    HUMAN_SAMPLING,
  );

  const generationId = await logGeneration({
    type: 'post',
    input_context: payload.content,
    meta: {
      inspiration: true,
      closeness: payload.closeness,
      source_tweet_id: payload.source_tweet_id,
      source_username: payload.source_username,
    },
    output: result.options,
    model: result.model,
    tokens_in: result.input_tokens,
    tokens_out: result.output_tokens,
  });

  return {
    generation_id: generationId,
    type: 'post',
    options: result.options,
    model: result.model,
  };
}

// ---------------------------------------------------------------------------
// "Harvest all"
//
// Chrome throttles background tabs and X only loads timeline content it thinks
// is visible, so a hidden tab yields roughly the first screen and nothing more.
// To get a full scrolled read the harvest window has to be a real, rendered
// window — so it opens as a small popup window, works through the creators one
// at a time, and closes itself when it's done.
// ---------------------------------------------------------------------------

/** How long to wait for one creator's page to load and harvest. */
const HARVEST_TIMEOUT_MS = 90_000;

const idleRun: HarvestRun = {
  running: false,
  done: 0,
  total: 0,
  current: null,
  finishedAt: null,
  harvested: 0,
  error: null,
  replace: false,
};

let run: HarvestRun = { ...idleRun };

/**
 * Creator list. Reads straight from IndexedDB now — the 5-minute cache the API
 * era needed is gone, since there is no network round trip left to save.
 */
async function creators(): Promise<CreatorsResponse> {
  return { creators: await listCreators() };
}

function setBadge(text: string, color = '#F6B44C') {
  void browser.action.setBadgeText({ text });
  void browser.action.setBadgeBackgroundColor({ color });
}

/**
 * Send a request to a tab, retrying until its content script is listening.
 *
 * Only *transport* failures are retried — a freshly navigated tab has no
 * listener yet, and that is the case this loop exists for. A well-formed
 * `{ok:false}` reply is the content script telling us the work itself failed,
 * and is returned immediately. Retrying those would be dangerous: a publish
 * that posted but failed its confirmation check would be sent again.
 */
async function askTab<T>(tabId: number, request: ContentRequest): Promise<T> {
  const deadline = Date.now() + HARVEST_TIMEOUT_MS;

  for (;;) {
    let res: BgResponseLike<T> | undefined;

    try {
      res = (await browser.tabs.sendMessage(tabId, request)) as BgResponseLike<T>;
    } catch (error) {
      if (Date.now() > deadline) throw error as Error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    if (res?.ok) return res.data;

    throw new Error(res?.error ?? 'The page did not respond.');
  }
}

/** Open one visible scratch window, drive it through `work`, then close it. */
async function inScratchWindow<T>(
  url: string,
  work: (tabId: number) => Promise<T>,
): Promise<T> {
  const scratch = await browser.windows.create({
    url,
    type: 'popup',
    width: 900,
    height: 800,
    focused: true,
  });

  try {
    const tabId = scratch?.tabs?.[0]?.id;

    if (tabId === undefined) throw new Error('Could not open a browser window.');

    return await work(tabId);
  } finally {
    if (scratch?.id !== undefined) {
      await browser.windows.remove(scratch.id).catch(() => {});
    }
  }
}

/**
 * Scroll the user's own profile in a scratch window and learn their voice from
 * what it finds. Same visibility constraint as harvesting: X won't load a
 * timeline it believes is off screen.
 */
async function learnFromProfile(): Promise<LearnResult> {
  const account = await accountItem.getValue();

  if (!account) {
    throw new Error('Connect your X account first.');
  }

  setBadge('…');

  try {
    const posts = await inScratchWindow(`https://x.com/${account.handle}`, (tabId) =>
      askTab<string[]>(tabId, { type: 'learn:scrape', handle: account.handle }),
    );

    return await learnVoice(account.handle, posts);
  } finally {
    setBadge('');
  }
}

/**
 * Harvest every tracked creator in one visible popup window.
 *
 * With `replace`, each creator's stored posts are wiped at the moment their
 * fresh batch is ingested — a full refresh of the Inspiration board, but done
 * creator by creator so a run that dies halfway (or a profile that fails to
 * load) can't leave the board empty.
 */
async function harvestAll(replace: boolean): Promise<HarvestRun> {
  if (run.running) return run;

  const { creators: tracked } = await creators();

  if (tracked.length === 0) {
    throw new Error('No creators tracked yet — add one on the Inspiration page.');
  }

  run = { ...idleRun, running: true, total: tracked.length, replace };

  // Not awaited: the popup closes the moment the harvest window takes focus,
  // so the run reports progress through the badge and `harvest:status`.
  void (async () => {
    try {
      await inScratchWindow(`https://x.com/${tracked[0].username}`, async (tabId) => {
        for (const [index, creator] of tracked.entries()) {
          run = { ...run, current: creator.username, done: index };
          setBadge(`${index + 1}/${tracked.length}`);

          if (index > 0) {
            await browser.tabs.update(tabId, {
              url: `https://x.com/${creator.username}`,
            });
          }

          try {
            const result = await askTab<HarvestResult>(tabId, {
              type: 'harvest:run',
              handle: creator.username,
            });

            if (result.count > 0) {
              await ingestInspiration({ ...result.payload, replace });
              run = { ...run, harvested: run.harvested + result.count };
            }
          } catch (error) {
            // One bad profile (suspended, renamed, rate-limited) shouldn't end
            // the whole run — record it and carry on.
            console.warn(`[X-Grow] Harvest failed for @${creator.username}`, error);
            run = { ...run, error: `@${creator.username}: ${(error as Error).message}` };
          }
        }
      });
    } catch (error) {
      run = { ...run, error: (error as Error).message };
    } finally {
      run = { ...run, running: false, current: null, done: run.total, finishedAt: Date.now() };
      setBadge('');
    }
  })();

  return run;
}

async function handle(message: BgRequest): Promise<unknown> {
  switch (message.type) {
    case 'settings:get':
      return settingsState();

    case 'account:detect':
      return detectAccount();

    case 'account:connect':
      return connectAccount(message.account);

    case 'account:disconnect':
      await accountItem.setValue(null);
      return settingsState();

    case 'settings:save':
      await setOpenAiConfig(message);
      return settingsState();

    case 'settings:test': {
      // Test what the user typed, before it's saved, so a bad key never lands.
      const current = await getOpenAiConfig();
      const config = {
        apiKey: message.apiKey ?? current.apiKey,
        model: message.model?.trim() || current.model,
        baseUrl: message.baseUrl?.trim() || current.baseUrl,
      };

      const result = await askModel(config, 'You are a test.', 'Reply with OK.', 16);

      return { model: result.model };
    }

    case 'voice:get':
      return getVoiceProfile();

    case 'voice:save':
      return saveVoiceProfile(message.patch);

    case 'voice:learn':
      return learnVoice(message.handle, message.posts);

    case 'voice:learn-from-profile':
      return learnFromProfile();

    case 'generate:reply':
      return generate('reply', message.payload);

    case 'generate:post':
      return generate('post', message.payload);

    case 'generate:recent':
      return {
        generations: await recentGenerations(
          message.payload.type,
          message.payload.input_context,
        ),
      };

    case 'inspiration:ingest':
      return ingestInspiration(message.payload);

    case 'inspiration:creators':
      return creators();

    case 'inspiration:posts':
      return listInspirationPosts();

    case 'inspiration:remix':
      return remix(message.payload);

    case 'creators:add':
      await addCreator(message.handle);
      return undefined;

    case 'creators:remove':
      await deleteCreator(message.handle);
      return undefined;

    case 'data:export':
      return exportAll();

    case 'data:import':
      await importAll(message.backup);
      return undefined;

    case 'harvest:all':
      return harvestAll(message.replace ?? false);

    case 'schedule:list':
      return listScheduledPosts();

    case 'schedule:generate':
      return generateWeek(message.input);

    case 'schedule:create':
      return createPost(message.input);

    case 'schedule:update':
      return updatePost(message.input);

    case 'schedule:generate-one':
      return generateSinglePost(message.category);

    case 'schedule:regenerate':
      return regeneratePost(message.id, message.category);

    case 'schedule:delete':
      await deleteScheduledPost(message.id);
      return undefined;

    case 'schedule:approve':
      return approvePost(message.id);

    case 'schedule:unapprove':
      return unapprovePost(message.id);

    case 'schedule:approve-week':
      return approveWeek(message.weekStart);

    case 'schedule:empty-week':
      return emptyWeek(message.weekStart);

    case 'schedule:publish-now': {
      const post = await getScheduledPost(message.id);

      if (!post) throw new Error('That post no longer exists.');

      return publishNow(post, publishDeps);
    }

    case 'harvest:status':
      return run;
  }
}

/** Everything publisher.ts needs from this module, passed in rather than imported. */
const publishDeps: PublishDeps = { inScratchWindow, askTab };

function runPublishTick(): void {
  void publishDue(publishDeps).catch((error) =>
    console.error('[X-Grow] Publish tick failed', error),
  );
}

/**
 * Ensure the publish alarm exists, without disturbing it if it already does.
 *
 * This runs on every service worker wake — a popup open, a content-script
 * message, the tick itself — so it must not call `alarms.create` blindly.
 * Creating an alarm that already exists *restarts its countdown*, which meant
 * a user clicking around the extension could hold the minute tick off
 * indefinitely and a scheduled post would never publish.
 *
 * The promise is awaited rather than dropped: `alarms.create` rejects when the
 * worker is being torn down mid-call, and an unhandled rejection here is what
 * surfaced as "Uncaught (in promise) Error: No SW" in the Errors panel.
 */
async function ensureAlarm(): Promise<void> {
  try {
    if (await browser.alarms.get(ALARM_NAME)) return;

    await browser.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  } catch (error) {
    console.error('[X-Grow] Could not schedule the publish alarm', error);
  }
}

export default defineBackground(() => {
  // The minute tick is what makes a scheduled post go out. `onStartup` is what
  // makes a post whose time passed while Chrome was closed go out late rather
  // than never — the single most important difference from a server cron.
  void ensureAlarm();
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) runPublishTick();
  });
  browser.runtime.onStartup.addListener(runPublishTick);
  browser.runtime.onInstalled.addListener(runPublishTick);

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handle(message as BgRequest)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message ?? 'Unknown error',
          status: error?.status,
        }),
      );

    // Return true to keep the message channel open for the async response.
    return true;
  });
});
