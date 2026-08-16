import { browser } from 'wxt/browser';
import { bg } from '@/lib/messaging';
import type { ContentRequest, HarvestResult } from '@/lib/messaging';
import { openPanel, openPolishPanel, openRemixPanel } from '@/lib/panel';
import type { CreatorProfile } from '@/lib/xdom';
import {
  findEditorFor,
  harvestTimeline,
  harvestVisiblePosts,
  ownProfileHandle,
  profileHandle,
  publishInComposer,
  readComposerContext,
  readEditorText,
  readLoggedInAccount,
  readProfileMeta,
  readTweetFor,
  scrapeOwnPosts,
  scrapeOwnTimeline,
  SEL,
  submitAnchor,
} from '@/lib/xdom';
import { ensureStyles } from '@/lib/xstyles';
import { polishSvg, remixSvg, sparkSvg } from '@/lib/xtheme';

/** Marks the ✨ composer button itself, so a re-render can be detected. */
const INJECTED = 'data-xgrow-ai';
const POLISH_INJECTED = 'data-xgrow-polish';
const LEARN_INJECTED = 'data-xgrow-learn';
const HARVEST_INJECTED = 'data-xgrow-harvest';
const HARVEST_FLOATING = 'data-xgrow-harvest-floating';
const REMIX_INJECTED = 'data-xgrow-remix';

/** How many of a creator's recent posts one harvest tries to collect. */
const HARVEST_TARGET = 60;

/**
 * The composer's ✨ button: an icon, not a label, sitting with X's own icon
 * controls next to the Reply button. X's toolbar is all glyphs — a text pill
 * there reads as an ad for a different product.
 */
function makeButton(toolbar: HTMLElement): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'xg-icon-btn';
  button.innerHTML = sparkSvg(20);
  button.title = 'Generate with X-Grow';
  button.setAttribute('aria-label', 'Generate with X-Grow');

  button.addEventListener('click', (event) => {
    // Don't let X handle or bubble this click.
    event.preventDefault();
    event.stopPropagation();

    const ctx = readComposerContext(toolbar);
    if (!ctx) return;
    openPanel(ctx);
  });

  return button;
}

/**
 * The composer's pencil button: fix the grammar and tighten the draft that is
 * already in the box.
 *
 * It sits next to ✨ but does the opposite thing — the spark writes something
 * from nothing, this one edits what you wrote — and it only appears once there
 * is a draft to work on, so an empty composer keeps X's own row uncluttered.
 */
function makePolishButton(toolbar: HTMLElement): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'xg-icon-btn';
  button.innerHTML = polishSvg(20);
  button.title = 'Fix grammar and tighten this draft';
  button.setAttribute('aria-label', 'Fix grammar and tighten this draft');

  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();

    const ctx = readComposerContext(toolbar);
    if (!ctx) return;

    const draft = readEditorText(ctx.editor);

    // The button is hidden while the composer is empty, but X re-renders this
    // row constantly and a click can land a frame before the sync catches up.
    if (draft === '') {
      toast('Write your post first, then polish it.', 'error');
      return;
    }

    openPolishPanel(ctx, draft);
  });

  return button;
}

/**
 * The remix button on a tweet's action row.
 *
 * The Inspiration board only holds posts from creators you track. This is the
 * same flow for anything you scroll past, without leaving the timeline.
 */
function makeRemixButton(actions: HTMLElement): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'xg-icon-btn xg-remix-btn';
  button.innerHTML = remixSvg(18);
  button.title = 'Remix this post in your voice';
  button.setAttribute('aria-label', 'Remix this post in your voice');

  button.addEventListener('click', (event) => {
    // X makes the whole tweet clickable; without this the click navigates.
    event.preventDefault();
    event.stopPropagation();

    const source = readTweetFor(actions);

    if (!source) {
      toast('Could not read that post. Try opening it first.', 'error');
      return;
    }

    openRemixPanel(source);
  });

  return button;
}

// Small transient status message pinned to the bottom of the screen, styled
// like X's own toasts (accent pill, bottom-centre).
function toast(message: string, tone: 'info' | 'success' | 'error' = 'info') {
  document.querySelector('[data-xgrow-toast]')?.remove();

  const el = document.createElement('div');
  el.setAttribute('data-xgrow-toast', '');
  el.className = 'xg-toast' + (tone === 'error' ? ' is-error' : '');
  el.textContent = message;
  document.body.append(el);
  return el;
}

function makeLearnButton(handle: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'xg-pill';
  button.innerHTML = `${sparkSvg(18)}<span>Learn my voice</span>`;
  button.title = 'Analyze your posts so X-Grow writes in your voice';

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
  button.className = 'xg-pill';
  button.innerHTML = `${sparkSvg(18)}<span>Harvest</span>`;
  button.title = `Send @${handle}'s recent posts to X-Grow Inspiration`;

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
  ensureStyles();

  // AI button on every composer toolbar. Checked by presence rather than by a
  // "done" flag on the toolbar: the button now lives in the Reply button's row,
  // and X re-renders that row whenever the Reply button enables/disables — a
  // flag would mark the toolbar done and never put the button back.
  document.querySelectorAll<HTMLElement>(SEL.toolBar).forEach((toolbar) => {
    if (!composerScope(toolbar).querySelector(`[${INJECTED}]`)) {
      mountComposerButton(toolbar);
    }
  });

  // Catches the composer opening with text already in it (a restored draft, or
  // a reply modal reopened). Typing is handled by the input listener instead.
  syncPolishButtons();

  // Remix button on every tweet's action row. Presence-checked like the
  // composer button rather than flagged: X recycles these rows as you scroll,
  // and a flag would let a reused row keep a button that no longer belongs to
  // the tweet now rendered in it.
  // Scoped to tweet articles: `[role="group"][aria-label]` on its own matches
  // other groups X renders, and we would hang a button off something that has
  // no post to remix.
  document
    .querySelectorAll<HTMLElement>(`${SEL.tweetArticle} ${SEL.tweetActions}`)
    .forEach((actions) => {
      if (actions.querySelector(`[${REMIX_INJECTED}]`)) return;

      const button = makeRemixButton(actions);
      button.setAttribute(REMIX_INJECTED, '');
      actions.append(button);
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
 * The part of the page that belongs to one composer: the reply modal if there
 * is one, else the toolbar's own surroundings. Used to ask "does *this*
 * composer already have our button?" without matching another composer's.
 */
function composerScope(toolbar: HTMLElement): HTMLElement {
  return toolbar.closest<HTMLElement>(SEL.dialog) ?? toolbar.parentElement ?? toolbar;
}

/**
 * Put the ✨ button immediately left of the composer's Reply/Post button.
 *
 * Falling back to the end of the icon row (rather than the start, as this used
 * to do) keeps it the right-most control either way, so the button lands in
 * roughly the same place even when X reshuffles the toolbar.
 */
function mountComposerButton(toolbar: HTMLElement) {
  const button = makeButton(toolbar);
  button.setAttribute(INJECTED, '');

  // Pencil to the left of the spark, so ✨ keeps its place next to the Post
  // button and the pair reads left-to-right as "fix mine" then "write mine".
  const polish = makePolishButton(toolbar);
  polish.setAttribute(POLISH_INJECTED, '');
  polish.hidden = true;

  const anchor = submitAnchor(toolbar);

  if (anchor) {
    anchor.parent.insertBefore(polish, anchor.before);
    anchor.parent.insertBefore(button, anchor.before);
    return;
  }

  // No Reply button found — sit at the end of the toolbar's icon row instead.
  const nav = toolbar.querySelector('nav');
  let target: HTMLElement = toolbar;

  if (nav) {
    let row = nav.querySelector<HTMLElement>('button, [role="button"]');
    while (row && row.parentElement !== nav) row = row.parentElement;
    if (row) target = row;
  }

  target.append(polish, button);
}

/**
 * Show the pencil only when there is a draft to polish.
 *
 * Driven by a document-level `input` listener rather than the MutationObserver
 * below: typing inside an existing text node is a `characterData` mutation, not
 * a `childList` one, so the observer can miss a whole first line being typed —
 * and observing characterData would re-run the full scan on every keystroke.
 */
function syncPolishButtons() {
  document.querySelectorAll<HTMLElement>(SEL.toolBar).forEach(syncPolishButton);
}

function syncPolishButton(toolbar: HTMLElement) {
  const button = composerScope(toolbar).querySelector<HTMLElement>(
    `[${POLISH_INJECTED}]`,
  );

  if (!button) return;

  const editor = findEditorFor(toolbar);

  button.hidden = !editor || readEditorText(editor) === '';
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
  button.classList.add('xg-floating');
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

      // Nor can it read the page to see who is signed in.
      if (request?.type === 'account:read') {
        sendResponse({ ok: true, data: readLoggedInAccount() });
        return false;
      }

      // Voice learning: scroll the user's own profile and hand back their posts.
      if (request?.type === 'learn:scrape') {
        const toastEl = toast('Reading your posts…');

        scrapeOwnTimeline(request.handle)
          .then((posts) => {
            toastEl.remove();
            sendResponse({ ok: true, data: posts });
          })
          .catch((error: Error) => {
            toastEl.remove();
            sendResponse({ ok: false, error: error?.message ?? 'Could not read your posts' });
          });

        return true;
      }

      // Publishing an approved scheduled post through X's own composer.
      if (request?.type === 'publish:run') {
        const toastEl = toast('X-Grow is posting…');

        publishInComposer(request.content, request.handle)
          .then((result) => {
            toastEl.remove();
            sendResponse({ ok: true, data: result });
          })
          .catch((error: Error) => {
            toastEl.remove();
            sendResponse({ ok: false, error: error?.message ?? 'Publishing failed' });
          });

        return true;
      }

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

    // Capture phase, so it still arrives if Draft stops the event on its way
    // up. One listener for the page's lifetime beats re-binding one per
    // composer, which X rebuilds constantly.
    document.addEventListener('input', syncPolishButtons, true);

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
