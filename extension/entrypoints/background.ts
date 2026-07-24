import { browser } from 'wxt/browser';
import {
  ApiError,
  generatePost,
  generateReply,
  getMe,
  ingestInspiration,
  learnVoice,
  listCreators,
  recentGeneration,
} from '@/lib/api';
import type { BgRequest, ContentRequest, HarvestResult } from '@/lib/messaging';
import { clearToken, getAuth, setAuth } from '@/lib/storage';
import type { AuthState, BgResponseLike, CreatorsResponse, HarvestRun } from '@/lib/types';

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
};

let run: HarvestRun = { ...idleRun };

/** Cached creator list, so every page view doesn't hit the API. */
let creatorCache: { at: number; data: CreatorsResponse } | null = null;
const CREATOR_TTL_MS = 5 * 60_000;

async function creators(fresh: boolean): Promise<CreatorsResponse> {
  if (!fresh && creatorCache && Date.now() - creatorCache.at < CREATOR_TTL_MS) {
    return creatorCache.data;
  }

  const { token, apiBaseUrl } = await getAuth();
  if (!token) throw new ApiError(401, 'Not connected. Open the popup and add your token.');

  const data = await listCreators(apiBaseUrl, token);
  creatorCache = { at: Date.now(), data };

  return data;
}

function setBadge(text: string, color = '#F6B44C') {
  void browser.action.setBadgeText({ text });
  void browser.action.setBadgeBackgroundColor({ color });
}

/** Ask a tab's content script for a full scrolled harvest of one creator. */
async function harvestInTab(tabId: number, handle: string): Promise<HarvestResult> {
  const request: ContentRequest = { type: 'harvest:run', handle };

  // The content script isn't listening until the page has loaded; retry until
  // it answers rather than guessing at a fixed delay.
  const deadline = Date.now() + HARVEST_TIMEOUT_MS;

  for (;;) {
    try {
      const res = (await browser.tabs.sendMessage(tabId, request)) as BgResponseLike<HarvestResult>;
      if (res?.ok) return res.data;
      throw new Error(res?.error ?? 'Harvest failed');
    } catch (error) {
      if (Date.now() > deadline) throw error as Error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function harvestAll(): Promise<HarvestRun> {
  if (run.running) return run;

  const { creators: tracked } = await creators(true);

  if (tracked.length === 0) {
    throw new ApiError(422, 'No creators tracked yet — add one on the Inspiration page.');
  }

  run = { ...idleRun, running: true, total: tracked.length };

  // Not awaited: the popup closes the moment the harvest window takes focus,
  // so the run reports progress through the badge and `harvest:status`.
  void (async () => {
    const harvestWindow = await browser.windows.create({
      url: `https://x.com/${tracked[0].username}`,
      type: 'popup',
      width: 900,
      height: 800,
      focused: true,
    });

    const tabId = harvestWindow?.tabs?.[0]?.id;

    try {
      if (tabId === undefined) throw new Error('Could not open a harvest window.');

      for (const [index, creator] of tracked.entries()) {
        run = { ...run, current: creator.username, done: index };
        setBadge(`${index + 1}/${tracked.length}`);

        if (index > 0) {
          await browser.tabs.update(tabId, { url: `https://x.com/${creator.username}` });
        }

        try {
          const result = await harvestInTab(tabId, creator.username);

          if (result.count > 0) {
            const { token, apiBaseUrl } = await getAuth();
            await ingestInspiration(apiBaseUrl, token, result.payload);
            run = { ...run, harvested: run.harvested + result.count };
          }
        } catch (error) {
          // One bad profile (suspended, renamed, rate-limited) shouldn't end
          // the whole run — record it and carry on.
          console.warn(`[X-Grow] Harvest failed for @${creator.username}`, error);
          run = { ...run, error: `@${creator.username}: ${(error as Error).message}` };
        }
      }
    } catch (error) {
      run = { ...run, error: (error as Error).message };
    } finally {
      run = { ...run, running: false, current: null, done: run.total, finishedAt: Date.now() };
      creatorCache = null;
      setBadge('');
      const windowId = harvestWindow?.id;
      if (windowId !== undefined) await browser.windows.remove(windowId).catch(() => {});
    }
  })();

  return run;
}

async function currentAuthState(): Promise<AuthState> {
  const { token, apiBaseUrl } = await getAuth();
  if (!token) {
    return { connected: false, apiBaseUrl, me: null };
  }

  try {
    const me = await getMe(apiBaseUrl, token);
    return { connected: true, apiBaseUrl, me };
  } catch {
    // Token invalid/expired or server unreachable — treat as disconnected.
    return { connected: false, apiBaseUrl, me: null };
  }
}

async function handle(message: BgRequest): Promise<unknown> {
  switch (message.type) {
    case 'auth:get':
      return currentAuthState();

    case 'auth:save': {
      // Verify the token works before persisting it.
      const me = await getMe(message.apiBaseUrl, message.token);
      await setAuth(message.token, message.apiBaseUrl);
      const { apiBaseUrl } = await getAuth();
      return { connected: true, apiBaseUrl, me } satisfies AuthState;
    }

    case 'auth:logout':
      await clearToken();
      return currentAuthState();

    case 'generate:reply': {
      const { token, apiBaseUrl } = await getAuth();
      if (!token) throw new ApiError(401, 'Not connected. Open the popup and add your token.');
      return generateReply(apiBaseUrl, token, message.payload);
    }

    case 'generate:post': {
      const { token, apiBaseUrl } = await getAuth();
      if (!token) throw new ApiError(401, 'Not connected. Open the popup and add your token.');
      return generatePost(apiBaseUrl, token, message.payload);
    }

    case 'generate:recent': {
      const { token, apiBaseUrl } = await getAuth();
      if (!token) throw new ApiError(401, 'Not connected. Open the popup and add your token.');
      return recentGeneration(apiBaseUrl, token, message.payload);
    }

    case 'voice:learn': {
      const { token, apiBaseUrl } = await getAuth();
      if (!token) throw new ApiError(401, 'Not connected. Open the popup and add your token.');
      return learnVoice(apiBaseUrl, token, message.handle, message.posts);
    }

    case 'inspiration:ingest': {
      const { token, apiBaseUrl } = await getAuth();
      if (!token) throw new ApiError(401, 'Not connected. Open the popup and add your token.');
      return ingestInspiration(apiBaseUrl, token, message.payload);
    }

    case 'inspiration:creators':
      return creators(message.fresh ?? false);

    case 'harvest:all':
      return harvestAll();

    case 'harvest:status':
      return run;
  }
}

export default defineBackground(() => {
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
