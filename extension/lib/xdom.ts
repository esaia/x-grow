/**
 * All X (Twitter) DOM knowledge lives here. X ships obfuscated, frequently
 * changing markup, so when the extension breaks this is almost always the file
 * to fix. It leans on `data-testid` hooks, which are the most stable handles X
 * exposes.
 */

export const SEL = {
  toolBar: '[data-testid="toolBar"]',
  // The contenteditable itself is tweetTextarea_0 (or _1, _2… in a thread).
  editor: '[data-testid^="tweetTextarea_"][contenteditable="true"]',
  tweetText: '[data-testid="tweetText"]',
  dialog: '[role="dialog"]',
  primaryColumn: '[data-testid="primaryColumn"]',
  // Only present on YOUR OWN profile page.
  editProfileButton: '[data-testid="editProfileButton"]',
  tweetArticle: 'article[data-testid="tweet"]',
  userName: '[data-testid="User-Name"]',
} as const;

export type ComposerMode = 'reply' | 'post';

export interface ComposerContext {
  mode: ComposerMode;
  editor: HTMLElement;
  /** The tweet being replied to (reply mode only). */
  tweet: string;
  /** The visible conversation above the composer (reply mode only). */
  threadContext: string;
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
    return { mode: 'post', editor, tweet: '', threadContext: '' };
  }

  const tweet = tweetsBefore[tweetsBefore.length - 1];
  // Include up to the last few tweets as conversation context.
  const threadContext = tweetsBefore.slice(-4).join('\n---\n');

  return { mode: 'reply', editor, tweet, threadContext };
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
