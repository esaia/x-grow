import { bg } from '@/lib/messaging';
import { openPanel } from '@/lib/panel';
import { ownProfileHandle, readComposerContext, scrapeOwnPosts, SEL } from '@/lib/xdom';

const INJECTED = 'data-xgrow-injected';
const LEARN_INJECTED = 'data-xgrow-learn';

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
  const handle = ownProfileHandle();
  if (handle) {
    const editBtn = document.querySelector<HTMLElement>(SEL.editProfileButton);
    const actions = editBtn?.parentElement;
    if (actions && !actions.hasAttribute(LEARN_INJECTED)) {
      actions.setAttribute(LEARN_INJECTED, '');
      actions.insertBefore(makeLearnButton(handle), actions.firstChild);
    }
  }
}

export default defineContentScript({
  matches: ['https://x.com/*', 'https://twitter.com/*'],
  main() {
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
