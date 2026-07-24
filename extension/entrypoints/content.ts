import { browser } from 'wxt/browser';
import { bg } from '@/lib/messaging';
import type { ContentRequest, HarvestResult } from '@/lib/messaging';
import { openPanel } from '@/lib/panel';
import type { CreatorProfile } from '@/lib/xdom';
import {
  harvestTimeline,
  harvestVisiblePosts,
  ownProfileHandle,
  profileHandle,
  readComposerContext,
  readProfileMeta,
  scrapeOwnPosts,
  SEL,
} from '@/lib/xdom';

const INJECTED = 'data-xgrow-injected';
const LEARN_INJECTED = 'data-xgrow-learn';
const HARVEST_INJECTED = 'data-xgrow-harvest';
const HARVEST_FLOATING = 'data-xgrow-harvest-floating';

/** How many of a creator's recent posts one harvest tries to collect. */
const HARVEST_TARGET = 60;

const BUTTON_CSS = `
  display: inline-flex !important; align-items: center; justify-content: center; gap: 5px;
  flex: 0 0 auto !important; min-width: 0 !important; width: fit-content !important;
  align-self: center !important; vertical-align: middle !important;
  margin-right: 6px; padding: 0 14px; height: 32px;
  border: 1px solid rgba(246,180,76,.5); border-radius: 999px;
  background: rgba(246,180,76,.1); color: #F6B44C;
  font-weight: 700; font-size: 13px; cursor: pointer;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  line-height: 1; white-space: nowrap;
`;

const BUTTON_SPARK =
  '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14" style="display:block">' +
  '<path d="M12 2C12.5 7 17 11.5 22 12C17 12.5 12.5 17 12 22C11.5 17 7 12.5 2 12C7 11.5 12.5 7 12 2Z"/>' +
  '</svg>';

function makeButton(toolbar: HTMLElement): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.innerHTML = `${BUTTON_SPARK}<span>AI</span>`;
  button.title = 'Generate with X-Grow';
  button.style.cssText = BUTTON_CSS;

  button.addEventListener('click', (event) => {
    // Don't let X handle or bubble this click.
    event.preventDefault();
    event.stopPropagation();

    const ctx = readComposerContext(toolbar);
    if (!ctx) return;
    openPanel(button, ctx);
  });

  return button;
}

// Small transient status message pinned to the bottom of the screen.
function toast(message: string, tone: 'info' | 'success' | 'error' = 'info') {
  document.querySelector('[data-xgrow-toast]')?.remove();

  const el = document.createElement('div');
  el.setAttribute('data-xgrow-toast', '');
  const color =
    tone === 'success' ? '#00BA7C' : tone === 'error' ? '#FF7A6B' : '#F6B44C';
  el.style.cssText = `
    position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
    z-index: 2147483647; max-width: 380px;
    background: #17151d; color: #F4F1EA; border: 1px solid rgba(255,255,255,.1);
    border-left: 3px solid ${color};
    padding: 11px 16px; border-radius: 12px; font-size: 13.5px; font-weight: 600;
    box-shadow: 0 16px 40px rgba(0,0,0,.5);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  `;
  el.textContent = message;
  document.body.append(el);
  return el;
}

function makeLearnButton(handle: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.innerHTML = `${BUTTON_SPARK}<span>Learn my voice</span>`;
  button.title = 'Analyze your posts so X-Grow writes in your voice';
  button.style.cssText = BUTTON_CSS + 'height: 34px; margin-right: 8px;';

  button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();

    const posts = scrapeOwnPosts(handle);
    if (posts.length < 3) {
      toast('Scroll down to load more of your posts, then click again.', 'error');
      return;
    }

    button.disabled = true;
    const pending = toast(`Learning your voice from ${posts.length} posts…`);

    const res = await bg.learnVoice(handle, posts);
    pending.remove();
    button.disabled = false;

    if (res.ok) {
      toast(`✓ Learned your voice from ${res.data.count} posts. Replies will match it now.`, 'success');
    } else {
      toast(res.error, 'error');
    }
  });

  return button;
}

/**
 * "Harvest" on another creator's profile: scroll their timeline, read the posts
 * and engagement counts X already rendered, and send them to the Inspiration
 * board. Replaces the platform's metered X API reads — the browser is loading
 * this data anyway.
 */
function makeHarvestButton(handle: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.innerHTML = `${BUTTON_SPARK}<span>Harvest</span>`;
  button.title = `Send @${handle}'s recent posts to X-Grow Inspiration`;
  button.style.cssText = BUTTON_CSS + 'height: 34px; margin-right: 8px;';

  button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();

    button.disabled = true;
    let pending = toast(`Reading @${handle}'s posts…`);

    const posts = await harvestTimeline(handle, HARVEST_TARGET, (count) => {
      pending.remove();
      pending = toast(`Reading @${handle}'s posts… ${count} found`);
    });

    pending.remove();

    if (posts.length === 0) {
      button.disabled = false;
      toast('No posts found on this page. Open the Posts tab and try again.', 'error');
      return;
    }

    const sending = toast(`Sending ${posts.length} posts to X-Grow…`);
    const res = await bg.ingestInspiration({
      handle,
      profile: readProfileMeta(handle),
      posts,
    });

    sending.remove();
    button.disabled = false;

    if (res.ok) {
      toast(
        `✓ Harvested ${res.data.received} posts from @${handle} — ${res.data.stored} stored.`,
        'success',
      );
    } else {
      toast(res.error, 'error');
    }
  });

  return button;
}

// ---------------------------------------------------------------------------
// Passive collection
//
// While you read a tracked creator's profile, whatever X has already rendered
// gets sent to the Inspiration board. Deliberately does NOT scroll: hijacking
// the page while someone is reading it would be worse than the manual click it
// replaces. Scrolled/deep harvesting is the background run's job instead.
// ---------------------------------------------------------------------------

/** Wait this long after the last newly-seen post before sending a batch. */
const PASSIVE_FLUSH_MS = 4000;

/** How long the tracked-creator list is reused before refetching. */
const TRACKED_TTL_MS = 15 * 60_000;

let trackedHandles: Set<string> | null = null;
let trackedFetchedAt = 0;

/**
 * Whether `handle` is a creator the user tracks. The list is cached, and the
 * first answer on a cold page is "no" — the refresh below resolves and later
 * re-scans (X mutates constantly) pick it up. Collection is passive, so being
 * a beat late costs nothing.
 */
function isTracked(handle: string): boolean {
  if (trackedHandles === null || Date.now() - trackedFetchedAt > TRACKED_TTL_MS) {
    trackedFetchedAt = Date.now();
    void bg.creators().then((res) => {
      if (res.ok) {
        trackedHandles = new Set(
          res.data.creators.map((creator) => creator.username.toLowerCase()),
        );
      }
    });
  }

  return trackedHandles?.has(handle.toLowerCase()) ?? false;
}

const passive = {
  handle: null as string | null,
  sent: new Set<string>(),
  pending: new Map<string, ReturnType<typeof harvestVisiblePosts>[number]>(),
  profile: null as CreatorProfile | null,
  timer: null as ReturnType<typeof setTimeout> | null,
};

function passiveCollect(handle: string, tracked: boolean) {
  if (!tracked) return;

  // Moved to a different creator — start a fresh batch.
  if (passive.handle !== handle) {
    passive.handle = handle;
    passive.sent.clear();
    passive.pending.clear();
    passive.profile = null;
  }

  // Snapshot the profile NOW. The flush runs seconds later, by which point an
  // SPA navigation may have swapped the page out from under us — reading the
  // header then labels the creator with whoever's profile is on screen.
  passive.profile = readProfileMeta(handle);

  let found = 0;
  for (const post of harvestVisiblePosts(handle)) {
    if (passive.sent.has(post.x_tweet_id)) continue;
    passive.pending.set(post.x_tweet_id, post);
    found++;
  }

  if (found === 0 || passive.pending.size === 0) return;

  if (passive.timer) clearTimeout(passive.timer);
  passive.timer = setTimeout(() => void flushPassive(), PASSIVE_FLUSH_MS);
}

async function flushPassive() {
  const handle = passive.handle;
  const posts = Array.from(passive.pending.values());

  if (!handle || posts.length === 0) return;

  passive.pending.clear();

  const res = await bg.ingestInspiration({
    handle,
    profile: passive.profile ?? { name: null, avatar_url: null, followers_count: null },
    posts,
  });

  if (res.ok) {
    for (const post of posts) passive.sent.add(post.x_tweet_id);
    console.log(`[X-Grow] Passively collected ${posts.length} posts from @${handle}.`);
  }
}

function scan() {
  // AI buttons on every composer toolbar.
  document.querySelectorAll<HTMLElement>(SEL.toolBar).forEach((toolbar) => {
    if (toolbar.hasAttribute(INJECTED)) return;
    toolbar.setAttribute(INJECTED, '');

    // X's icon buttons don't sit directly in the toolbar — they live in a flex
    // row (align-items:center) inside the toolbar's <nav>. Inserting into the
    // toolbar itself leaves our pill a few px too high; inserting into a single
    // icon's wrapper clips it. Target the icon ROW: the <nav>'s child that
    // actually contains the icons. Verified to center perfectly (cy diff 0).
    const nav = toolbar.querySelector('nav');
    let target: HTMLElement = toolbar;
    if (nav) {
      let row = nav.querySelector<HTMLElement>('button, [role="button"]');
      while (row && row.parentElement !== nav) row = row.parentElement;
      if (row) target = row;
    }
    target.insertBefore(makeButton(toolbar), target.firstChild);
  });

  // "Learn my voice" next to the Edit-profile button on your own profile.
  const own = ownProfileHandle();
  if (own) {
    const editBtn = document.querySelector<HTMLElement>(SEL.editProfileButton);
    const actions = editBtn?.parentElement;
    if (actions && !actions.hasAttribute(LEARN_INJECTED)) {
      actions.setAttribute(LEARN_INJECTED, '');
      actions.insertBefore(makeLearnButton(own), actions.firstChild);
    }
  }

  // "Harvest" on anyone else's profile.
  const creator = own ? null : profileHandle();
  if (creator) {
    mountHarvestButton(creator);
    passiveCollect(creator, isTracked(creator));
  } else {
    // Navigated away from a profile — drop the floating button if it's up.
    document.querySelector(`[${HARVEST_FLOATING}]`)?.remove();
  }
}

/**
 * Whether an element sits inside a pinned (sticky or fixed) container — i.e.
 * the compact header X shows once you scroll a profile, rather than the profile
 * body itself. Checked by computed style so it survives X's class churn.
 */
function isPinned(el: HTMLElement): boolean {
  let node: HTMLElement | null = el;

  for (let i = 0; i < 8 && node; i++) {
    const position = getComputedStyle(node).position;
    if (position === 'sticky' || position === 'fixed') return true;
    node = node.parentElement;
  }

  return false;
}

/**
 * Place the Harvest button in the profile's action row, next to Follow.
 *
 * Two anchors are tried. The follow button is the nicest position but its
 * testid encodes follow state, and on an account you already follow it did not
 * match — so the "⋯" button, which is present either way, backs it up. When
 * neither is found we fall back to a floating pill rather than showing nothing:
 * harvesting is the whole point of being on this page.
 */
function mountHarvestButton(handle: string) {
  const existing = document.querySelector(`[${HARVEST_FLOATING}]`);

  // Prefer the "⋯" button's row. Once you scroll, X pins a compact header with
  // its own Follow button — anchoring on Follow puts our pill up there, hanging
  // over the page. That sticky bar has no "⋯", so this lands in the real
  // profile row; a Follow button inside a sticky/fixed ancestor is skipped.
  const anchor =
    document.querySelector<HTMLElement>(SEL.userActions) ??
    Array.from(document.querySelectorAll<HTMLElement>(SEL.followButton)).find(
      (el) => !isPinned(el),
    );
  const actions =
    anchor?.closest<HTMLElement>('[data-testid="placementTracking"]')
      ?.parentElement ?? anchor?.parentElement;

  if (actions) {
    existing?.remove();

    if (!actions.hasAttribute(HARVEST_INJECTED)) {
      actions.setAttribute(HARVEST_INJECTED, '');
      actions.insertBefore(makeHarvestButton(handle), actions.firstChild);
      console.log(`[X-Grow] Harvest button mounted inline for @${handle}.`);
    }
    return;
  }

  // The floating pill is keyed by handle so it survives re-scans but is
  // rebuilt when the user navigates to a different creator.
  if (existing?.getAttribute(HARVEST_FLOATING) === handle) return;
  existing?.remove();

  console.log(
    `[X-Grow] No follow-button anchor found for @${handle} — using the floating Harvest button.`,
  );

  const button = makeHarvestButton(handle);
  button.setAttribute(HARVEST_FLOATING, handle);
  button.style.cssText += `
    position: fixed; right: 24px; bottom: 24px; z-index: 2147483646;
    height: 40px; padding: 0 18px; margin: 0;
    background: #17151d; box-shadow: 0 10px 30px rgba(0,0,0,.5);
  `;
  document.body.append(button);
}

export default defineContentScript({
  matches: ['https://x.com/*', 'https://twitter.com/*'],
  main() {
    console.log('[X-Grow] Content script loaded.');

    // A background "harvest all" run drives this tab: it navigates here, then
    // asks for a full scrolled read. Scrolling is safe in that window because
    // it exists only for harvesting.
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const request = message as ContentRequest;
      if (request?.type !== 'harvest:run') return false;

      const toastEl = toast(`Harvesting @${request.handle}…`);

      harvestTimeline(request.handle, HARVEST_TARGET)
        .then((posts) => {
          toastEl.remove();
          sendResponse({
            ok: true,
            data: {
              count: posts.length,
              payload: {
                handle: request.handle,
                profile: readProfileMeta(request.handle),
                posts,
              },
            } satisfies HarvestResult,
          });
        })
        .catch((error: Error) => {
          toastEl.remove();
          sendResponse({ ok: false, error: error?.message ?? 'Harvest failed' });
        });

      // Keep the channel open for the async response.
      return true;
    });

    scan();

    // X is a SPA: composers mount/unmount as the user navigates and opens
    // reply modals. Re-scan (throttled) whenever the DOM changes.
    let queued = false;
    const observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        scan();
      });
    });

    observer.observe(document.body, { childList: true, subtree: true });
  },
});
