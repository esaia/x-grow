/**
 * All X (Twitter) DOM knowledge lives here. X ships obfuscated, frequently
 * changing markup, so when the extension breaks this is almost always the file
 * to fix. It leans on `data-testid` hooks, which are the most stable handles X
 * exposes.
 */

export const SEL = {
  toolBar: '[data-testid="toolBar"]',
  // Profile header: display name + @handle, avatar, and the follower links.
  profileName: '[data-testid="UserName"]',
  // Suffixed with the account's handle — and present for the logged-in user in
  // the left nav too, so always match the suffix rather than taking the first.
  profileAvatar: '[data-testid^="UserAvatar-Container-"]',
  followersLink: 'a[href$="/verified_followers"], a[href$="/followers"]',
  // The row of reply/repost/like buttons under a tweet. Its aria-label carries
  // EXACT counts ("12 replies, 5 reposts, 300 likes…"); the visible button
  // labels are abbreviated ("1.2K"), so prefer the aria-label.
  tweetActions: '[role="group"][aria-label]',
  socialContext: '[data-testid="socialContext"]',
  // Present on OTHER people's profiles (the id prefix is their user id, and
  // the suffix changes with follow state).
  followButton:
    '[data-testid$="-follow"], [data-testid$="-unfollow"], [data-testid$="-subscribe"], [data-testid$="-unsubscribe"]',
  // The "⋯" button in the same profile action row. Unlike the follow button,
  // it is there whether or not you already follow the account, which makes it
  // the more dependable anchor of the two.
  userActions: '[data-testid="userActions"]',
  // The contenteditable itself is tweetTextarea_0 (or _1, _2… in a thread).
  editor: '[data-testid^="tweetTextarea_"][contenteditable="true"]',
  tweetText: '[data-testid="tweetText"]',
  dialog: '[role="dialog"]',
  primaryColumn: '[data-testid="primaryColumn"]',
  // Only present on YOUR OWN profile page.
  editProfileButton: '[data-testid="editProfileButton"]',
  tweetArticle: 'article[data-testid="tweet"]',
  userName: '[data-testid="User-Name"]',
  // The composer's Post/Reply button. `tweetButtonInline` is the one on an
  // inline composer; `tweetButton` is the modal's.
  submitButton: '[data-testid="tweetButtonInline"], [data-testid="tweetButton"]',
  // The account chip at the bottom of the left nav: the logged-in user's
  // avatar, display name and @handle, present on every x.com screen.
  sideNavAccount: '[data-testid="SideNav_AccountSwitcher_Button"]',
  // The nav's "Profile" link. Its href is /<handle>, which makes it the most
  // dependable read of who is logged in.
  profileLink: 'a[data-testid="AppTabBar_Profile_Link"]',
} as const;

export type ComposerMode = 'reply' | 'post';

export interface ComposerContext {
  mode: ComposerMode;
  editor: HTMLElement;
  /** The tweet being replied to (reply mode only). */
  tweet: string;
  /** The visible conversation above the composer (reply mode only). */
  threadContext: string;
  /** The individual tweets above the composer, oldest first — the original
   * post through the immediate comment being replied to (reply mode only). */
  contextTweets: string[];
}

/**
 * The handle of the profile currently being viewed, but only if it's the
 * logged-in user's OWN profile (detected via the "Edit profile" button, which
 * X only renders on your own page).
 */
export function ownProfileHandle(): string | null {
  if (!document.querySelector(SEL.editProfileButton)) return null;
  const segment = location.pathname.split('/').filter(Boolean)[0];
  return segment ? segment.replace(/^@/, '') : null;
}

/** The X account this browser is signed in to, as shown in the left nav. */
export interface XAccount {
  handle: string;
  name: string | null;
  avatar_url: string | null;
}

/**
 * Who is logged in to x.com, readable from any screen.
 *
 * This is why the extension needs no OAuth: it already runs inside the user's
 * own authenticated session, so "connect your X account" is a read plus a
 * confirmation click, not a token handshake.
 *
 * The handle comes from the nav's Profile link (an href, the least fragile
 * thing on the page), falling back to the avatar container's testid suffix.
 * Everything else is best-effort and may come back null on a half-rendered nav.
 */
export function readLoggedInAccount(): XAccount | null {
  const href = document
    .querySelector<HTMLAnchorElement>(SEL.profileLink)
    ?.getAttribute('href');

  const chip = document.querySelector<HTMLElement>(SEL.sideNavAccount);

  const handle =
    href?.split('/').filter(Boolean)[0] ??
    chip
      ?.querySelector(SEL.profileAvatar)
      ?.getAttribute('data-testid')
      ?.replace('UserAvatar-Container-', '');

  if (!handle || RESERVED_PATHS.has(handle.toLowerCase())) return null;

  // The chip renders "Display Name" then "@handle"; take what precedes the @.
  const text = chip?.textContent ?? '';
  const name = text.split('@')[0].trim() || null;

  return {
    handle: handle.replace(/^@/, ''),
    name,
    avatar_url: chip?.querySelector('img')?.getAttribute('src') ?? null,
  };
}

/**
 * Scrape the profile owner's own posts from the currently-loaded page,
 * skipping reposts of other accounts.
 */
export function scrapeOwnPosts(handle: string, limit = 40): string[] {
  const at = `@${handle}`.toLowerCase();
  const posts: string[] = [];
  const seen = new Set<string>();

  document
    .querySelectorAll(`${SEL.primaryColumn} ${SEL.tweetArticle}`)
    .forEach((article) => {
      const author = article
        .querySelector(SEL.userName)
        ?.textContent?.match(/@[A-Za-z0-9_]+/)?.[0]
        ?.toLowerCase();

      // Skip reposts of other people (their voice, not yours).
      if (author && author !== at) return;

      const text = article.querySelector(SEL.tweetText)?.textContent?.trim();
      if (text && text.length > 1 && !seen.has(text)) {
        seen.add(text);
        posts.push(text);
      }
    });

  return posts.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Inspiration harvesting
//
// Reads a creator's recent posts (text + engagement) straight off their profile
// page, using the session the user is already browsing with. This is what the
// platform used to pay X's metered API for; the browser loads the same data for
// free as part of rendering the page.
// ---------------------------------------------------------------------------

/** Top-level x.com paths that are app screens, not profiles. */
const RESERVED_PATHS = new Set([
  'home', 'explore', 'notifications', 'messages', 'settings', 'compose', 'search',
  'i', 'intent', 'about', 'tos', 'privacy', 'login', 'logout', 'signup', 'jobs',
  'bookmarks', 'lists', 'communities', 'premium', 'topics', 'hashtag',
]);

/**
 * The @handle of the profile currently being viewed (anyone's, including your
 * own), or null when the page isn't a profile.
 */
export function profileHandle(): string | null {
  const segments = location.pathname.split('/').filter(Boolean);

  // A profile is exactly /<handle> — /<handle>/status/<id> and the profile
  // sub-tabs (/with_replies, /media…) are a different view with a different
  // timeline, so only harvest from the main Posts tab.
  //
  // Detection is deliberately URL-only. Confirming against a header element
  // would be more precise, but it makes the button vanish silently whenever X
  // renames that testid — and being wrong here costs nothing, since the button
  // is inert on a page with no timeline.
  if (segments.length !== 1) return null;

  const handle = segments[0].replace(/^@/, '');
  if (RESERVED_PATHS.has(handle.toLowerCase())) return null;

  return handle;
}

/** Parse a count as X renders it: "1,234", "1.2K", "3.4M". */
export function parseCount(text: string | null | undefined): number {
  if (!text) return 0;

  const match = text.replace(/,/g, '').match(/([\d.]+)\s*([KMB])?/i);
  if (!match) return 0;

  const value = parseFloat(match[1]);
  if (Number.isNaN(value)) return 0;

  const scale = { k: 1e3, m: 1e6, b: 1e9 }[match[2]?.toLowerCase() ?? ''] ?? 1;

  return Math.round(value * scale);
}

export interface CreatorProfile {
  name: string | null;
  avatar_url: string | null;
  followers_count: number | null;
}

/**
 * Display name, avatar and follower count from the profile header.
 *
 * Everything is read from inside the primary column. The left nav holds the
 * *logged-in* user's own avatar in an identically-named container, and it comes
 * first in document order — a document-wide lookup silently returns your own
 * picture for every creator you harvest.
 */
export function readProfileMeta(handle: string): CreatorProfile {
  const column = document.querySelector(SEL.primaryColumn) ?? document;

  // The block renders "Display Name" then "@handle" — take everything before
  // the @ as the display name, but only once the @handle in it confirms whose
  // profile is actually on screen. Like the avatar, an unverified name is worth
  // less than none: it would relabel a creator with whoever the page belongs to.
  const nameBlock = Array.from(
    column.querySelectorAll(SEL.profileName),
  ).find((el) =>
    (el.textContent ?? '').toLowerCase().includes(`@${handle.toLowerCase()}`),
  );
  const name = nameBlock?.textContent?.split('@')[0]?.trim() || null;

  // X suffixes the container's testid with the account's own handle. Match on
  // that suffix and nothing else: an avatar is only worth sending if we know
  // whose it is, and showing the wrong person's face on every card is worse
  // than showing none (the server keeps whatever it already had when this is
  // null).
  // Both lookups are keyed to the handle, so neither can return someone else's
  // face. The second one — the header avatar links to /<handle>/photo — is a
  // structural fallback for when X renames that testid, because otherwise a
  // null here would leave an already-wrong stored avatar in place forever.
  const avatar =
    Array.from(column.querySelectorAll<HTMLElement>(SEL.profileAvatar)).find(
      (el) =>
        el.dataset.testid?.slice('UserAvatar-Container-'.length).toLowerCase() ===
        handle.toLowerCase(),
    ) ??
    Array.from(column.querySelectorAll<HTMLAnchorElement>('a[href$="/photo"]')).find(
      (el) =>
        new URL(el.href).pathname.toLowerCase() === `/${handle.toLowerCase()}/photo`,
    );

  const followersLink = column.querySelector(SEL.followersLink);
  const followers = followersLink ? parseCount(followersLink.textContent) : 0;

  return {
    name,
    avatar_url: avatar?.querySelector('img')?.src ?? null,
    followers_count: followers || null,
  };
}

export interface HarvestedPost {
  x_tweet_id: string;
  content: string;
  url: string;
  posted_at: string | null;
  metrics: { like: number; reply: number; retweet: number; quote: number };
}

/**
 * Engagement counts for one tweet article.
 *
 * The action row's aria-label holds exact numbers, which is why it is preferred
 * — but it's localized, so when the regexes miss, fall back to the visible
 * button labels (abbreviated, hence less precise). Quote counts appear in
 * neither, so they stay 0; the platform's engagement score tolerates that.
 */
function readMetrics(article: Element): HarvestedPost['metrics'] {
  const label = article.querySelector(SEL.tweetActions)?.getAttribute('aria-label') ?? '';
  const exact = (pattern: RegExp): number => {
    const match = label.match(pattern);
    return match ? parseCount(match[1]) : 0;
  };

  const metrics = {
    reply: exact(/([\d,]+)\s+repl/i),
    retweet: exact(/([\d,]+)\s+(?:repost|retweet)/i),
    like: exact(/([\d,]+)\s+like/i),
    quote: 0,
  };

  if (metrics.reply || metrics.retweet || metrics.like) return metrics;

  const button = (testId: string) =>
    parseCount(article.querySelector(`[data-testid="${testId}"]`)?.textContent);

  return {
    reply: button('reply'),
    retweet: button('retweet') || button('unretweet'),
    like: button('like') || button('unlike'),
    quote: 0,
  };
}

/**
 * Harvest every tweet currently rendered on the profile timeline that was
 * actually written by `handle`.
 *
 * Reposts of other accounts are excluded by reading the author out of the
 * permalink rather than the visible "reposted" label, which is localized. The
 * permalink is the anchor wrapping the timestamp; a quoted tweet's own links
 * appear later in the article, so the first match is always the outer post's.
 */
export function harvestVisiblePosts(handle: string): HarvestedPost[] {
  const at = handle.toLowerCase();
  const posts: HarvestedPost[] = [];
  const seen = new Set<string>();

  document
    .querySelectorAll(`${SEL.primaryColumn} ${SEL.tweetArticle}`)
    .forEach((article) => {
      const permalink = article
        .querySelector('a[href*="/status/"] time')
        ?.closest('a');

      const match = permalink
        ?.getAttribute('href')
        ?.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)/);
      if (!match) return;

      const [, author, id] = match;
      if (author.toLowerCase() !== at || seen.has(id)) return;

      const content = article.querySelector(SEL.tweetText)?.textContent?.trim();
      if (!content) return;

      seen.add(id);
      posts.push({
        x_tweet_id: id,
        content,
        url: `https://x.com/${author}/status/${id}`,
        posted_at:
          permalink?.querySelector('time')?.getAttribute('datetime') ?? null,
        metrics: readMetrics(article),
      });
    });

  return posts;
}

/**
 * Scroll the timeline until `target` posts by `handle` have loaded, then return
 * them and restore the original scroll position.
 *
 * X virtualizes the timeline — articles scrolled far out of view are removed
 * from the DOM — so posts are collected as we go rather than read once at the
 * end. Stops early after a few rounds without new posts (end of timeline, or a
 * rate-limit interstitial).
 */
export async function harvestTimeline(
  handle: string,
  target = 60,
  onProgress?: (count: number) => void,
): Promise<HarvestedPost[]> {
  const collected = new Map<string, HarvestedPost>();
  const startY = window.scrollY;
  let idleRounds = 0;

  const collect = () => {
    const before = collected.size;
    for (const post of harvestVisiblePosts(handle)) {
      // Later sightings win: counts only ever grow, and a re-render may have
      // filled in a metric that was still loading the first time around.
      collected.set(post.x_tweet_id, post);
    }
    if (collected.size > before) {
      idleRounds = 0;
      onProgress?.(collected.size);
    } else {
      idleRounds++;
    }
  };

  collect();

  for (let round = 0; round < 40 && collected.size < target && idleRounds < 4; round++) {
    window.scrollBy(0, window.innerHeight * 0.9);
    await new Promise((resolve) => setTimeout(resolve, 700));
    collect();
  }

  window.scrollTo(0, startY);

  return Array.from(collected.values()).slice(0, target);
}

/**
 * The scrolling counterpart to scrapeOwnPosts(): walk the user's own profile
 * far enough to gather a usable voice sample. Same virtualization problem as
 * harvestTimeline — X recycles rows out of the DOM, so posts are accumulated as
 * we go rather than read once at the end.
 */
export async function scrapeOwnTimeline(
  handle: string,
  target = 40,
): Promise<string[]> {
  const collected = new Set<string>();
  const startY = window.scrollY;
  let idleRounds = 0;

  const collect = () => {
    const before = collected.size;
    for (const post of scrapeOwnPosts(handle, Number.MAX_SAFE_INTEGER)) {
      collected.add(post);
    }
    if (collected.size > before) idleRounds = 0;
    else idleRounds++;
  };

  collect();

  for (let round = 0; round < 30 && collected.size < target && idleRounds < 4; round++) {
    window.scrollBy(0, window.innerHeight * 0.9);
    await new Promise((resolve) => setTimeout(resolve, 700));
    collect();
  }

  window.scrollTo(0, startY);

  return Array.from(collected).slice(0, target);
}

// ---------------------------------------------------------------------------
// Publishing
//
// Scheduled posts go out by driving X's own composer in the user's own session.
// That is why there is no OAuth app, no client secret and no paid X API tier —
// but it also means this is the most breakable code in the extension, so every
// step verifies rather than assuming, and a failure is always explicit.
// ---------------------------------------------------------------------------

/** Poll for something to appear, up to `timeout` ms. */
async function waitFor<T>(
  read: () => T | null | undefined,
  timeout: number,
  interval = 250,
): Promise<T | null> {
  const deadline = Date.now() + timeout;

  for (;;) {
    const value = read();

    if (value) return value;
    if (Date.now() > deadline) return null;

    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/** Whether X currently considers the composer's Post button clickable. */
function submitEnabled(button: HTMLElement): boolean {
  return (
    button.getAttribute('aria-disabled') !== 'true' &&
    !(button as HTMLButtonElement).disabled
  );
}

export interface PublishResult {
  /** The tweet id, when the post-publish URL happens to reveal it. */
  external_post_id: string | null;
}

/**
 * Publish `content` through the composer on the current page.
 *
 * `expectHandle` is the account the post was scheduled for. X can be signed in
 * to someone else by the time the alarm fires (the user switched accounts), and
 * posting a scheduled draft from the wrong account is worse than not posting
 * it, so that mismatch is a hard failure.
 */
export async function publishInComposer(
  content: string,
  expectHandle: string,
): Promise<PublishResult> {
  const account = await waitFor(() => readLoggedInAccount(), 15_000);

  if (!account) {
    throw new Error('Not signed in to X. Sign in and retry this post.');
  }

  if (account.handle.toLowerCase() !== expectHandle.toLowerCase()) {
    throw new Error(
      `X is signed in as @${account.handle}, but this post is for @${expectHandle}.`,
    );
  }

  const editor = await waitFor(
    () => document.querySelector<HTMLElement>(SEL.editor),
    20_000,
  );

  if (!editor) {
    throw new Error("X's composer did not open.");
  }

  insertIntoEditor(editor, content);

  // X enables Post only once it has processed the input, so wait for the
  // button to go live rather than clicking into a disabled control.
  const submit = await waitFor(() => {
    const button = document.querySelector<HTMLElement>(SEL.submitButton);

    return button && submitEnabled(button) ? button : null;
  }, 10_000);

  if (!submit) {
    throw new Error(
      'The Post button never became active — the text may not have registered.',
    );
  }

  // Guard against posting something other than what was approved.
  const typed = editor.textContent ?? '';

  if (typed.trim() === '') {
    throw new Error('The composer was still empty after inserting the text.');
  }

  submit.click();

  // Success looks like the composer emptying or closing. Both are X telling us
  // it accepted the post; neither is a guess about the network.
  const sent = await waitFor(() => {
    const current = document.querySelector<HTMLElement>(SEL.editor);

    return !current || (current.textContent ?? '').trim() === '' ? true : null;
  }, 20_000);

  if (!sent) {
    throw new Error('X did not confirm the post. Check your X account.');
  }

  // Best effort: if X navigated to the new post, its id is in the URL. This is
  // a nicety for linking back, never something the flow depends on.
  const id = /\/status\/(\d+)/.exec(location.pathname)?.[1] ?? null;

  return { external_post_id: id };
}

/**
 * Read the tweet an action row belongs to, for the on-timeline remix button.
 *
 * Author and id both come from the permalink on the timestamp — the same
 * approach harvestVisiblePosts uses, and for the same reason: it survives
 * localized "reposted by" labels and tells us whose post this really is, which
 * the header does not on a repost.
 */
export function readTweetFor(actions: HTMLElement): {
  content: string;
  username: string;
  x_tweet_id: string;
  url: string;
} | null {
  const article = actions.closest<HTMLElement>(SEL.tweetArticle);

  if (!article) return null;

  const permalink = article
    .querySelector('a[href*="/status/"] time')
    ?.parentElement?.getAttribute('href');

  const match = permalink?.match(/^\/([^/]+)\/status\/(\d+)/);

  if (!match) return null;

  const content = article.querySelector(SEL.tweetText)?.textContent?.trim();

  if (!content) return null;

  return {
    content,
    username: match[1],
    x_tweet_id: match[2],
    url: `https://x.com${permalink}`,
  };
}

/** Find the contenteditable belonging to the composer that owns `toolbar`. */
export function findEditorFor(toolbar: HTMLElement): HTMLElement | null {
  let el: HTMLElement | null = toolbar.parentElement;
  for (let i = 0; i < 6 && el; i++) {
    const editor = el.querySelector<HTMLElement>(SEL.editor);
    if (editor) return editor;
    el = el.parentElement;
  }
  return document.querySelector<HTMLElement>(SEL.editor);
}

/**
 * Where to put the ✨ button so it lands immediately to the LEFT of the
 * composer's Reply/Post button, as one more control in that group.
 *
 * The Reply button is usually a few wrappers deep, so climb out of the
 * single-child wrappers until we reach the node that actually sits in a row
 * with siblings — that row is the composer's right-hand action group, and
 * inserting before our node there puts us in the group rather than nested
 * inside the button's own wrapper (which stacks it instead of aligning it).
 */
export function submitAnchor(
  toolbar: HTMLElement,
): { parent: HTMLElement; before: HTMLElement } | null {
  const scope = toolbar.closest(SEL.dialog) ?? toolbar.parentElement ?? toolbar;
  const submit =
    toolbar.querySelector<HTMLElement>(SEL.submitButton) ??
    scope.querySelector<HTMLElement>(SEL.submitButton);

  if (!submit) return null;

  let node: HTMLElement = submit;

  for (let i = 0; i < 6; i++) {
    const parent = node.parentElement;
    if (!parent || parent === toolbar) break;
    if (parent.childElementCount > 1) break;
    node = parent;
  }

  const parent = node.parentElement;

  return parent ? { parent, before: node } : null;
}

function textOf(el: Element): string {
  return (el.textContent ?? '').trim();
}

/**
 * Inspect the DOM around a composer's toolbar to decide whether it's a reply or
 * a fresh post, and gather the tweet/thread context when it's a reply.
 */
export function readComposerContext(toolbar: HTMLElement): ComposerContext | null {
  const editor = findEditorFor(toolbar);
  if (!editor) return null;

  // Reply composers live either inside a dialog (reply modal) or inline on a
  // status page. In both cases the tweet(s) being replied to appear *before*
  // the editor in document order.
  const scope: ParentNode = toolbar.closest(SEL.dialog) ?? document;

  const tweetsBefore = Array.from(scope.querySelectorAll(SEL.tweetText))
    .filter(
      (node) =>
        editor.compareDocumentPosition(node) &
        Node.DOCUMENT_POSITION_PRECEDING,
    )
    .map(textOf)
    .filter(Boolean);

  if (tweetsBefore.length === 0) {
    // Nothing above the composer → it's a brand-new post.
    return { mode: 'post', editor, tweet: '', threadContext: '', contextTweets: [] };
  }

  const tweet = tweetsBefore[tweetsBefore.length - 1];
  // Include up to the last few tweets as conversation context — this carries
  // the original post through to the immediate comment, not just the comment.
  const contextTweets = tweetsBefore.slice(-4);
  const threadContext = contextTweets.join('\n---\n');

  return { mode: 'reply', editor, tweet, threadContext, contextTweets };
}

/**
 * Replace the editor's content with `text`.
 *
 * X's composer is a Draft.js contenteditable. `execCommand('insertText')` is
 * unusable here: the browser performs the native DOM insertion AND Draft's own
 * `beforeinput` handler inserts the same text into its model, so the text lands
 * TWICE (e.g. "…wrong thing.sell something…"). Instead we hand Draft a
 * synthetic paste event — Draft has a dedicated paste handler that inserts the
 * text exactly once, as real editor state (deletable, enables the Post button).
 */
export function insertIntoEditor(editor: HTMLElement, text: string): void {
  editor.focus();

  // Select any existing content so the paste REPLACES it instead of appending.
  document.execCommand('selectAll', false);

  const data = new DataTransfer();
  data.setData('text/plain', text);

  const pasted = editor.dispatchEvent(
    new ClipboardEvent('paste', {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    }),
  );

  // If nothing consumed the paste (event not cancelled), Draft didn't handle
  // it — fall back to a single beforeinput/input pair. Note: no execCommand
  // here, precisely to avoid the native+Draft double insertion.
  if (pasted) {
    editor.dispatchEvent(
      new InputEvent('beforeinput', {
        inputType: 'insertReplacementText',
        data: text,
        bubbles: true,
        cancelable: true,
      }),
    );
    editor.dispatchEvent(
      new InputEvent('input', {
        inputType: 'insertReplacementText',
        data: text,
        bubbles: true,
      }),
    );
  }
}
