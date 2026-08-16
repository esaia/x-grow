import { POST_FORMATS, TONES } from '@/lib/ai/prompts';
import { REPLY_OPTION_COUNT } from '@/lib/config';
import { bg } from '@/lib/messaging';
import { dateKey, localTimezone, timeKey } from '@/lib/time';
import { type ComposerContext, insertIntoEditor } from '@/lib/xdom';
import { FONT_STACK, readXTheme, sparkSvg, themeVars } from '@/lib/xtheme';

let openHost: HTMLElement | null = null;
let openOverlay: HTMLElement | null = null;
let cleanup: (() => void) | null = null;
// The footer's primary button for the state currently on screen, so ⌘/Ctrl+Enter
// can trigger it from anywhere in the modal.
let primary: HTMLButtonElement | null = null;

// Keep in sync with the .xg-overlay/.xg-panel transition durations below.
const EXIT_MS = 130;

// The two slots every state renders into: the scrolling body and the pinned footer.
type PanelUI = { body: HTMLElement; foot: HTMLElement };

// Plays the fade-out first, then detaches. `immediate` skips it — used when a
// new panel is about to replace this one, so the two never overlap.
function closePanel(immediate = false) {
  cleanup?.();
  cleanup = null;
  primary = null;

  const host = openHost;
  const overlay = openOverlay;
  openHost = null;
  openOverlay = null;
  if (!host) return;

  if (immediate || !overlay) {
    host.remove();
    return;
  }

  // Stop it swallowing clicks while it fades away.
  overlay.classList.remove('is-open');
  overlay.classList.add('is-closing');
  setTimeout(() => host.remove(), EXIT_MS);
}

// Tiny hyperscript helper.
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) el.className = cls;
  Object.assign(el, rest);
  for (const child of children) {
    el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

/** X's own close glyph, so the modal header matches theirs exactly. */
const CLOSE_SVG =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true" ' +
  'style="display:block"><path d="M10.59 12L4.54 5.96l1.42-1.42L12 10.59l6.04-6.05 1.42 1.42L13.41 ' +
  '12l6.05 6.04-1.42 1.42L12 13.41l-6.04 6.05-1.42-1.42L10.59 12z"/></svg>';

function spark(): HTMLElement {
  const s = h('span', { class: 'xg-spark' });
  s.innerHTML = sparkSvg(20);
  return s;
}

function microLabel(text: string): HTMLElement {
  return h('div', { class: 'xg-label', textContent: text });
}

function field(label: string, control: Node, cls = ''): HTMLElement {
  return h('div', { class: 'xg-field' + (cls ? ` ${cls}` : '') }, microLabel(label), control);
}

// The conversation the reply lands in: the original post (and any intermediate
// tweets) followed by the immediate comment. Showing the whole thread — not
// only the comment — makes clear the AI has the post as context too.
// Long posts are line-clamped rather than cropped to a pixel height, so the
// last visible line is never sliced in half; the toggle below reveals the rest
// (and only appears when something is actually hidden).
function replyContext(ctx: ComposerContext): HTMLElement {
  const tweets = ctx.contextTweets.length ? ctx.contextTweets : [ctx.tweet];
  const quotes = h('div', { class: 'xg-context' });
  tweets.forEach((text, i) => {
    const last = i === tweets.length - 1;
    if (tweets.length > 1) {
      quotes.append(h('div', {
        class: 'xg-context-role',
        textContent: last ? 'Comment' : i === 0 ? 'Original post' : 'Earlier reply',
      }));
    }
    quotes.append(h('div', {
      class: 'xg-quote' + (last ? '' : ' is-parent'),
      textContent: text,
    }));
  });

  const toggle = h('button', { class: 'xg-more', type: 'button', textContent: 'Show more' });
  toggle.hidden = true;
  toggle.addEventListener('click', () => {
    const expanded = quotes.classList.toggle('is-expanded');
    toggle.textContent = expanded ? 'Show less' : 'Show more';
  });

  // Measured after layout — scrollHeight is meaningless until the panel is laid out.
  requestAnimationFrame(() => {
    const clipped = [...quotes.querySelectorAll('.xg-quote')].some(
      (q) => q.scrollHeight > q.clientHeight + 1,
    );
    toggle.hidden = !clipped;
  });

  return h('div', { class: 'xg-context-wrap' }, quotes, toggle);
}

// A row of single-select pill chips. Returns the element + a current-value getter.
function chipGroup(
  values: readonly string[],
  initial: string,
  ariaLabel: string,
): { el: HTMLElement; get: () => string } {
  let current = values.includes(initial) ? initial : values[0];
  const chips: HTMLButtonElement[] = [];

  const el = h('div', { class: 'xg-chips' });
  el.setAttribute('role', 'radiogroup');
  el.setAttribute('aria-label', ariaLabel);

  for (const value of values) {
    const chip = h('button', {
      class: 'xg-chip' + (value === current ? ' is-active' : ''),
      type: 'button',
      textContent: value,
    });
    chip.setAttribute('role', 'radio');
    chip.setAttribute('aria-checked', String(value === current));
    chip.addEventListener('click', () => {
      current = value;
      for (const c of chips) {
        const on = c === chip;
        c.classList.toggle('is-active', on);
        c.setAttribute('aria-checked', String(on));
      }
    });
    chips.push(chip);
    el.append(chip);
  }

  return { el, get: () => current };
}

function loading(message: string): HTMLElement {
  return h(
    'div',
    { class: 'xg-loading' },
    h('span', { class: 'xg-ring' }),
    h('span', { textContent: message }),
  );
}

// "just now", "5m ago", "3h ago", "2d ago" — good enough for a subtle timestamp.
function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * The panel's look is X's, measured off the live page (see `xtheme.ts`): their
 * background/accent/text tokens, their Chirp font, their 15px body size, their
 * fully-round buttons, their 16px dialog radius, and their row-per-item lists
 * with a hover wash instead of bordered cards.
 */
function style(): string {
  const theme = readXTheme();

  return `
:host { all: initial; }
* { box-sizing: border-box; font-family: ${FONT_STACK}; }

.xg-overlay {
  ${themeVars(theme)}
  position: fixed; inset: 0; z-index: 2147483647;
  display: flex; align-items: center; justify-content: center;
  padding: 32px 16px;
  background: var(--xg-scrim);
  opacity: 0;
  transition: opacity .16s ease-out;
}
.xg-overlay.is-open { opacity: 1; }
.xg-overlay.is-closing { opacity: 0; pointer-events: none; transition-duration: .13s; }

.xg-panel {
  position: relative;
  width: 100%; max-width: 600px;
  max-height: 100%; min-height: 0;
  background: var(--xg-bg); color: var(--xg-text);
  border-radius: 16px;
  /* X's own modal elevation: a soft light halo in the dark themes, a plain
     drop shadow on white. */
  box-shadow: ${
    theme.dark
      ? 'rgba(255,255,255,.2) 0 0 15px, rgba(255,255,255,.15) 0 0 3px 1px'
      : 'rgba(101,119,134,.2) 0 0 15px, rgba(101,119,134,.15) 0 0 3px 1px'
  };
  overflow: hidden; font-size: 15px; line-height: 1.3125;
  display: flex; flex-direction: column;
  opacity: 0; transform: translateY(8px) scale(.99);
  transition: opacity .16s ease-out, transform .18s cubic-bezier(.2,.8,.25,1);
}
.xg-overlay.is-open .xg-panel { opacity: 1; transform: none; }
.xg-overlay.is-closing .xg-panel {
  opacity: 0; transform: translateY(6px) scale(.99);
  transition-duration: .13s;
}
@keyframes xg-in { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }

/* X's modal header: 53px tall, close button on the LEFT of the title. */
.xg-head {
  display: flex; align-items: center; gap: 20px;
  min-height: 53px; padding: 0 16px;
  flex: 0 0 auto;
}
.xg-head-acts { display: flex; align-items: center; gap: 12px; margin-left: auto; }
.xg-esc { font-size: 13px; color: var(--xg-muted); }
.xg-brand { display: flex; align-items: center; gap: 10px; }
.xg-spark { display: inline-flex; color: var(--xg-accent); }
.xg-spark svg { display: block; }
.xg-title { font-weight: 700; font-size: 20px; line-height: 24px; }

/* X's round icon button, used for close and any other glyph control. */
.xg-x {
  all: unset; box-sizing: border-box; cursor: pointer;
  color: var(--xg-text); width: 34px; height: 34px; margin-left: -8px;
  display: grid; place-items: center; border-radius: 9999px;
  font-size: 17px; line-height: 1; transition: background-color .2s;
}
.xg-x:hover { background: var(--xg-hover); }
.xg-x:focus-visible { box-shadow: 0 0 0 2px var(--xg-accent); }

.xg-body { padding: 12px 16px 16px; display: flex; flex-direction: column; gap: 20px;
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  scrollbar-width: thin; scrollbar-color: var(--xg-line) transparent; }
.xg-body::-webkit-scrollbar { width: 10px; }
.xg-body::-webkit-scrollbar-thumb { background: var(--xg-line);
  border-radius: 8px; border: 3px solid transparent; background-clip: padding-box; }
.xg-body::-webkit-scrollbar-track { background: transparent; }

/* X labels sections in plain secondary text, not letterspaced small caps. */
.xg-label { font-size: 13px; color: var(--xg-muted); margin-bottom: 8px; }

/* The post being replied to stays pinned while the options scroll under it —
   once results render, the inputs are otherwise scrolled off the top and you
   lose sight of what the replies are answering. Negative margins let it span
   the body's padding so scrolled content never peeks through the gap. */
.xg-sticky {
  position: sticky; top: 0; z-index: 2;
  margin: -12px -16px 0; padding: 12px 16px;
  background: var(--xg-bg);
  border-bottom: 1px solid var(--xg-line);
}

.xg-context-wrap { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
.xg-context { display: flex; flex-direction: column; gap: 10px; align-self: stretch; }
/* Expanded posts can be long — cap the pinned block and let it scroll rather
   than pushing the replies off screen. */
.xg-context.is-expanded { max-height: 220px; overflow-y: auto; padding-right: 4px;
  scrollbar-width: thin; scrollbar-color: var(--xg-line) transparent; }
.xg-more {
  all: unset; box-sizing: border-box; cursor: pointer;
  font-size: 15px; color: var(--xg-accent); padding: 2px 0; margin-left: 14px;
}
.xg-more:hover { text-decoration: underline; }
.xg-more:focus-visible { box-shadow: 0 0 0 2px var(--xg-accent); border-radius: 4px; }

.xg-context-role { font-size: 13px; color: var(--xg-muted); margin-bottom: -6px; }
.xg-quote {
  font-size: 15px; line-height: 20px; color: var(--xg-text);
  border-left: 2px solid var(--xg-line); padding: 1px 0 1px 12px;
  overflow: hidden; overflow-wrap: anywhere;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3;
}
.xg-quote.is-parent { color: var(--xg-muted); -webkit-line-clamp: 2; }
.xg-context.is-expanded .xg-quote { -webkit-line-clamp: unset; }

/* X's text fields: 4px radius, hairline border, accent border on focus. */
.xg-input {
  width: 100%; font: inherit; font-size: 15px; line-height: 20px; color: var(--xg-text);
  background: transparent; border: 1px solid var(--xg-line); border-radius: 4px;
  padding: 12px; resize: vertical; min-height: 88px;
}
.xg-input::placeholder { color: var(--xg-muted); }
.xg-input:focus { outline: none; border-color: var(--xg-accent); }

/* Date/time fields share the text-field look but must not inherit the
   textarea's min-height, or a one-line input renders three lines tall. */
.xg-when { display: flex; gap: 8px; }
.xg-when .xg-input {
  min-height: 0; padding: 10px 12px; resize: none;
  color-scheme: ${theme.dark ? 'dark' : 'light'};
}

.xg-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.xg-chip {
  all: unset; box-sizing: border-box; cursor: pointer;
  font-size: 14px; font-weight: 700; color: var(--xg-text);
  background: transparent; border: 1px solid var(--xg-line);
  padding: 0 16px; height: 32px; display: inline-flex; align-items: center;
  border-radius: 9999px; text-transform: capitalize;
  transition: background-color .2s, border-color .2s;
}
.xg-chip:hover { background: var(--xg-hover); }
.xg-chip.is-active {
  color: var(--xg-on-accent); border-color: transparent; background: var(--xg-accent);
}
.xg-chip.is-active:hover { background: var(--xg-accent-hover); }
.xg-chip:focus-visible { box-shadow: 0 0 0 2px var(--xg-accent); }

.xg-foot {
  flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between;
  gap: 12px; padding: 12px 16px; border-top: 1px solid var(--xg-line);
}
.xg-foot:empty { display: none; }
.xg-hint { font-size: 13px; color: var(--xg-muted); }

/* X's primary button — their Post-button fill (white on dark, black on light),
   15px bold, fully round, 36px tall. Not the accent colour. */
.xg-generate {
  all: unset; box-sizing: border-box; cursor: pointer; text-align: center;
  margin-left: auto; padding: 0 20px; height: 36px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 9999px; font-weight: 700; font-size: 15px;
  color: var(--xg-on-primary); background: var(--xg-primary);
  transition: background-color .2s;
}
.xg-generate:hover { background: var(--xg-primary-hover); }
.xg-generate:focus-visible { box-shadow: 0 0 0 2px var(--xg-bg), 0 0 0 4px var(--xg-accent); }
.xg-generate:disabled { opacity: .5; cursor: default; }

.xg-output:empty { display: none; }
.xg-output:not(:empty) { animation: xg-in .16s ease-out; }

.xg-recent {
  border-top: 1px solid var(--xg-line); padding-top: 16px;
  display: flex; flex-direction: column; gap: 16px;
  animation: xg-in .14s ease-out;
}
.xg-recent > .xg-label { margin-bottom: 0; }

/* Results read as X timeline rows: full-bleed, divided by hairlines, with the
   standard hover wash — not as bordered cards, which X never uses. */
.xg-opts { display: flex; flex-direction: column; margin: 0 -16px; }
.xg-opt {
  padding: 12px 16px; border-top: 1px solid var(--xg-line);
  transition: background-color .2s;
}
.xg-opt:hover { background: var(--xg-hover); }
.xg-opt-text { margin: 0 0 12px; white-space: pre-wrap; line-height: 20px; font-size: 15px; }
.xg-opt-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.xg-count { font-size: 13px; color: var(--xg-muted); }
.xg-count.over { color: var(--xg-danger); }
.xg-acts { display: flex; gap: 8px; }

/* Outcome line under an option's actions: where it landed, or why it didn't. */
.xg-saved {
  display: block; margin-top: 6px; font-size: 13px; line-height: 16px;
  color: var(--xg-muted);
}
.xg-saved:empty { display: none; }

/* An advisory, not an error: X's accent wash, no border, like their own
   inline notices. */
.xg-warn {
  margin: 0; padding: 12px; border-radius: 8px;
  background: var(--xg-accent-wash); color: var(--xg-text);
  font-size: 13px; line-height: 18px;
}

/* X's small buttons: 32px tall, fully round; secondary is outlined. */
.xg-btn {
  all: unset; box-sizing: border-box; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  height: 32px; padding: 0 16px; border-radius: 9999px;
  font-size: 14px; font-weight: 700;
  border: 1px solid var(--xg-line); color: var(--xg-text); background: transparent;
  transition: background-color .2s;
}
.xg-btn:hover { background: var(--xg-hover); }
.xg-btn:focus-visible { box-shadow: 0 0 0 2px var(--xg-accent); }
.xg-btn.insert {
  color: var(--xg-on-primary); border-color: transparent; background: var(--xg-primary);
}
.xg-btn.insert:hover { background: var(--xg-primary-hover); }

.xg-regen {
  all: unset; box-sizing: border-box; cursor: pointer; text-align: center;
  margin-left: auto; height: 36px; padding: 0 20px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 9999px; font-size: 15px; font-weight: 700;
  color: var(--xg-text); border: 1px solid var(--xg-line);
  transition: background-color .2s;
}
.xg-regen:hover { background: var(--xg-hover); }
.xg-regen:focus-visible { box-shadow: 0 0 0 2px var(--xg-accent); }

.xg-note { color: var(--xg-muted); font-size: 15px; line-height: 20px; margin: 2px 0; }
.xg-err { color: var(--xg-danger); font-size: 15px; line-height: 20px; margin: 0; }

/* X's loading state is a single accent ring, nothing else. */
.xg-loading { display: flex; align-items: center; gap: 12px; color: var(--xg-muted);
  font-size: 15px; padding: 16px 0; }
.xg-ring {
  width: 20px; height: 20px; flex: 0 0 auto; border-radius: 9999px;
  border: 2px solid var(--xg-line); border-top-color: var(--xg-accent);
  animation: xg-spin .8s linear infinite;
}
@keyframes xg-spin { to { transform: rotate(360deg); } }

@media (prefers-reduced-motion: reduce) {
  .xg-overlay, .xg-panel { transition: none; }
  .xg-panel { transform: none; }
  .xg-recent { animation: none; }
  .xg-ring { animation: none; }
}
`;
}

export function openPanel(ctx: ComposerContext): void {
  const ui = openShell(ctx.mode === 'reply' ? 'AI reply' : 'AI post');

  renderInputs(ui, ctx, ctx.mode === 'reply');
}

/**
 * Build the modal — shadow root, overlay, header, body, footer, and every
 * dismissal path — and hand back the two slots a state renders into.
 *
 * Shared by the composer panel and the remix panel so the two are the same
 * object to the user: same chrome, same Escape/⌘↵ behaviour, same X styling.
 */
function openShell(title: string): PanelUI {
  closePanel(true);

  const host = document.createElement('div');
  host.setAttribute('data-xgrow-panel', '');
  openHost = host;

  const shadow = host.attachShadow({ mode: 'open' });
  // Read fresh so the panel follows a theme/accent change without a reload.
  shadow.append(h('style', { textContent: style() }));

  const body = h('div', { class: 'xg-body' });
  const foot = h('div', { class: 'xg-foot' });

  const closeBtn = h('button', { class: 'xg-x', type: 'button', title: 'Close' });
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML = CLOSE_SVG;
  // Wrapped: passing the listener directly would hand the event to `immediate`.
  closeBtn.addEventListener('click', () => closePanel());

  // X puts the close button at the head of the modal header, left of the
  // title, rather than floating it at the far right.
  const panel = h(
    'div',
    { class: 'xg-panel' },
    h(
      'div',
      { class: 'xg-head' },
      closeBtn,
      h('div', { class: 'xg-brand' }, spark(), h('span', {
        class: 'xg-title',
        textContent: title,
      })),
      h('div', { class: 'xg-head-acts' },
        h('span', { class: 'xg-esc', textContent: 'esc' })),
    ),
    body,
    foot,
  );
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');

  // A full-viewport overlay in the top layer: centred, never clipped by X's
  // containers, and unaffected by scrolling — so there's no position to track.
  const overlay = h('div', { class: 'xg-overlay' }, panel);
  openOverlay = overlay;
  shadow.append(overlay);
  document.body.appendChild(host);

  // Flip to the open state a frame later so the entry transition actually runs.
  requestAnimationFrame(() => overlay.classList.add('is-open'));

  // Keep clicks inside the modal from leaking into X's composer handlers.
  host.addEventListener('mousedown', (e) => e.stopPropagation());
  host.addEventListener('click', (e) => e.stopPropagation());

  // Dismiss on backdrop click / Escape; ⌘↵ fires the footer's primary action.
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) closePanel();
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closePanel();
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && primary && !primary.disabled) {
      e.preventDefault();
      primary.click();
    }
  };
  // Shadow-DOM keydowns are composed, so they reach this document listener too.
  document.addEventListener('keydown', onKey);
  cleanup = () => {
    document.removeEventListener('keydown', onKey);
  };

  return { body, foot };
}

// Put a state's primary action in the footer (with an optional left-hand hint)
// and register it as the ⌘↵ target.
function setFooter(foot: HTMLElement, button: HTMLButtonElement, hint?: string) {
  primary = button;
  foot.replaceChildren(
    ...(hint ? [h('span', { class: 'xg-hint', textContent: hint })] : []),
    button,
  );
}

async function renderInputs(
  ui: PanelUI,
  ctx: ComposerContext,
  isReply: boolean,
) {
  const { body, foot } = ui;
  body.replaceChildren(loading('Loading your voice…'));
  foot.replaceChildren();
  primary = null;

  const settings = await bg.getSettings();
  if (!settings.ok) {
    body.replaceChildren(h('p', { class: 'xg-note' }, settings.error));
    return;
  }
  if (!settings.data.account) {
    body.replaceChildren(
      h('p', { class: 'xg-note' },
        'Connect your X account first — open X-Grow in the left sidebar, or click the toolbar icon.'),
    );
    return;
  }
  if (!settings.data.hasKey) {
    body.replaceChildren(
      h('p', { class: 'xg-note' },
        'Open the X-Grow icon in your toolbar and add your OpenAI API key to start generating.'),
    );
    return;
  }

  const tones = [...TONES];
  const profile = settings.data.voiceProfile;
  const defaultTone = profile?.tone ?? 'balanced';

  /*
   * With an empty profile the model has nothing specific to be specific about,
   * so it falls back to the generic observations that read as AI — and with no
   * facts to draw on, the prompt forbids it from saying anything about the
   * owner's life at all. Say so here rather than letting the user conclude the
   * product is just bad.
   */
  const thinVoice =
    !profile?.sample_posts?.trim() &&
    !profile?.voice_analysis?.trim() &&
    !profile?.facts?.trim();

  /*
   * Replies don't get a tone picker. Seven chips is a decision to make while
   * mid-scroll on someone else's tweet, and the answer is always the profile's
   * default anyway — the tone that makes a reply land is set by the tweet
   * you're answering, not by a chip. Composing a post is the opposite: you
   * opened the panel on purpose, so the choice is worth showing there.
   */
  const toneGroup = isReply ? null : chipGroup(tones, defaultTone, 'Tone');

  let topic: HTMLTextAreaElement | null = null;
  let formatGroup: { el: HTMLElement; get: () => string } | null = null;

  const controls: HTMLElement[] = [];

  if (isReply) {
    controls.push(field('Replying to', replyContext(ctx), 'xg-sticky'));
  } else {
    topic = h('textarea', {
      class: 'xg-input',
      placeholder: "What's this post about? A topic, a link, or a rough idea.",
    });
    formatGroup = chipGroup(POST_FORMATS, 'single', 'Format');
    controls.push(field('Topic', topic));
    controls.push(field('Format', formatGroup.el));
    controls.push(field('Tone', toneGroup!.el));
  }

  const generate = h('button', {
    class: 'xg-generate',
    type: 'button',
    // Posts don't pass a count, so the API's default of 3 applies to them.
    textContent: isReply ? `Write ${REPLY_OPTION_COUNT} replies` : 'Write 3 posts',
  });

  const regen = h('button', { class: 'xg-regen', type: 'button', textContent: 'Regenerate' });
  const retry = h('button', { class: 'xg-regen', type: 'button', textContent: 'Try again' });

  // Results render *below* the inputs, never replacing them: the tweet you're
  // replying to (or the topic and format you typed) stays on screen, so a
  // regenerate is one click away.
  const output = h('div', { class: 'xg-output' });

  const run = async () => {
    if (!isReply && !topic?.value.trim()) {
      topic?.focus();
      return;
    }

    // A fresh batch supersedes the "previously generated" list.
    body.querySelector('.xg-recent')?.remove();
    output.replaceChildren(loading(isReply ? 'Writing your replies…' : 'Writing your posts…'));
    output.scrollIntoView({ block: 'nearest' });
    foot.replaceChildren();
    primary = null;

    // No picker on replies: the background falls back to the profile's tone.
    const tone = toneGroup?.get() ?? defaultTone;
    const res = isReply
      ? await bg.reply({
          tweet: ctx.tweet,
          thread_context: ctx.threadContext || undefined,
          tone,
          count: REPLY_OPTION_COUNT,
        })
      : await bg.post({
          topic: topic!.value.trim(),
          format: formatGroup!.get() as 'single' | 'hook' | 'thread',
          tone,
        });

    if (!res.ok) {
      output.replaceChildren(h('p', { class: 'xg-err', textContent: res.error }));
      setFooter(foot, retry);
      return;
    }

    const enforce280 = isReply || formatGroup!.get() !== 'thread';
    renderResults(output, ctx, isReply, res.data.options, enforce280);
    setFooter(foot, regen);
  };

  generate.addEventListener('click', run);
  regen.addEventListener('click', run);
  retry.addEventListener('click', run);

  if (thinVoice) {
    controls.push(
      h('p', { class: 'xg-warn' },
        'Your voice profile is empty, so replies will read generic. Add a few ' +
        'of your real posts in the X-Grow toolbar icon → Voice profile.'),
    );
  }

  body.replaceChildren(...controls, output);
  setFooter(foot, generate, '⌘↵ to generate');

  // For replies, surface the last set we already generated for THIS exact
  // tweet, so the user can re-insert without paying for a regeneration. Runs
  // after the inputs render so it never blocks the panel.
  if (isReply) void showRecentReplies(body, ctx);
}

async function showRecentReplies(body: HTMLElement, ctx: ComposerContext) {
  const res = await bg.recent({ type: 'reply', input_context: ctx.tweet });
  if (!res.ok || res.data.generations.length === 0) return;

  // Panel may have moved on (regenerated, closed) while we were fetching.
  if (!body.isConnected || body.querySelector('.xg-recent')) return;

  const gens = res.data.generations;
  const total = gens.reduce((n, g) => n + g.output.length, 0);

  // One labelled group per generation batch (newest first), so each batch keeps
  // its own timestamp/tone context instead of blurring 6 replies into one list.
  const groups = gens.map((gen) => {
    const when = relativeTime(gen.created_at);
    const tone = gen.meta?.tone;
    const cards = gen.output.map((text) => optionCard(ctx, text, true));
    return h(
      'div',
      { class: 'xg-recent-batch' },
      microLabel([when, tone].filter(Boolean).join(' · ') || 'Earlier'),
      h('div', { class: 'xg-opts' }, ...cards),
    );
  });

  const section = h(
    'div',
    { class: 'xg-recent' },
    microLabel(`Previously generated · ${total} repl${total === 1 ? 'y' : 'ies'}`),
    ...groups,
  );

  // Above the output slot, so a fresh batch always lands below these.
  body.insertBefore(section, body.querySelector('.xg-output'));
}

function counterFor(text: string, enforce280: boolean): HTMLElement {
  const el = h('span', { class: 'xg-count' });
  if (enforce280) {
    const n = text.length;
    el.textContent = `${n}/280`;
    if (n > 280) el.classList.add('over');
  } else {
    const tweets = text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean).length;
    el.textContent = `${tweets} tweet${tweets === 1 ? '' : 's'} · ${text.length} chars`;
  }
  return el;
}

// A single generated option: the text, a char/tweet counter, Copy and Insert.
function optionCard(ctx: ComposerContext, text: string, enforce280: boolean): HTMLElement {
  const insert = h('button', { class: 'xg-btn insert', type: 'button', textContent: 'Insert' });
  insert.addEventListener('click', () => {
    insertIntoEditor(ctx.editor, text);
    closePanel();
  });

  const copy = h('button', { class: 'xg-btn', type: 'button', textContent: 'Copy' });
  copy.addEventListener('click', () => {
    navigator.clipboard.writeText(text);
    copy.textContent = 'Copied';
    setTimeout(() => (copy.textContent = 'Copy'), 1200);
  });

  return h(
    'div',
    { class: 'xg-opt' },
    h('p', { class: 'xg-opt-text', textContent: text }),
    h('div', { class: 'xg-opt-foot' }, counterFor(text, enforce280),
      h('div', { class: 'xg-acts' }, copy, insert)),
  );
}

function renderResults(
  output: HTMLElement,
  ctx: ComposerContext,
  isReply: boolean,
  options: string[],
  enforce280: boolean,
) {
  const cards = options.map((text) => optionCard(ctx, text, enforce280));
  const noun = isReply
    ? `repl${options.length === 1 ? 'y' : 'ies'}`
    : `post${options.length === 1 ? '' : 's'}`;

  output.replaceChildren(
    microLabel(`${options.length} ${noun} · pick one to insert`),
    h('div', { class: 'xg-opts' }, ...cards),
  );
  output.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------------------
// Remix
//
// The Inspiration board only holds posts from creators you track. This is the
// same flow for anything you scroll past: hit the remix button on any tweet and
// rewrite it in your voice, without leaving the timeline.
// ---------------------------------------------------------------------------

/** The tweet a remix is based on, read off the article that was clicked. */
export interface RemixSource {
  content: string;
  username: string;
  x_tweet_id: string;
  url: string;
}

const CLOSENESS_LABELS: Record<string, string> = {
  build: 'Keep it close',
  balanced: 'Balanced',
  mine: 'Make it mine',
};

export function openRemixPanel(source: RemixSource): void {
  const ui = openShell('Remix this post');

  renderRemixInputs(ui, source);
}

async function renderRemixInputs(ui: PanelUI, source: RemixSource) {
  const { body, foot } = ui;

  body.replaceChildren(loading('Loading your voice…'));
  foot.replaceChildren();
  primary = null;

  const settings = await bg.getSettings();

  if (!settings.ok) {
    body.replaceChildren(h('p', { class: 'xg-note' }, settings.error));
    return;
  }

  if (!settings.data.account) {
    body.replaceChildren(
      h('p', { class: 'xg-note' },
        'Connect your X account first — click the X-Grow icon in your toolbar.'),
    );
    return;
  }

  if (!settings.data.hasKey) {
    body.replaceChildren(
      h('p', { class: 'xg-note' },
        'Add your OpenAI API key in the X-Grow toolbar icon to start generating.'),
    );
    return;
  }

  const closeness = chipGroup(
    Object.keys(CLOSENESS_LABELS),
    'balanced',
    'How close to the original',
  );

  // The chips read as keys otherwise ("build", "mine"), which says nothing.
  closeness.el.querySelectorAll('.xg-chip').forEach((chip, i) => {
    const key = Object.keys(CLOSENESS_LABELS)[i];
    chip.textContent = CLOSENESS_LABELS[key];
  });

  const instructions = h('textarea', {
    class: 'xg-input',
    placeholder: 'Optional: steer it. "Make it about my own launch."',
  });

  const quote = h('div', { class: 'xg-context' },
    h('div', { class: 'xg-context-role', textContent: `@${source.username}` }),
    h('div', { class: 'xg-quote', textContent: source.content }),
  );

  body.replaceChildren(
    field('Original', h('div', { class: 'xg-context-wrap' }, quote), 'xg-sticky'),
    field('How close to the original', closeness.el),
    field('Steer it', instructions),
  );

  const generate = h('button', {
    class: 'xg-generate',
    type: 'button',
    textContent: 'Write 3 versions',
  });

  const run = async () => {
    generate.disabled = true;
    generate.textContent = 'Writing…';

    // Rendered below the inputs, never over them, so the closeness you chose
    // stays visible next to what it produced.
    let output = body.querySelector('.xg-output');

    if (!output) {
      output = h('div', { class: 'xg-output' });
      body.append(output);
    }

    output.replaceChildren(loading('Rewriting in your voice…'));

    const res = await bg.remix({
      content: source.content,
      closeness: closeness.get() as 'build' | 'balanced' | 'mine',
      instructions: instructions.value.trim() || null,
      source_tweet_id: source.x_tweet_id,
      source_username: source.username,
    });

    generate.disabled = false;
    generate.textContent = 'Try again';

    if (!res.ok) {
      output.replaceChildren(h('p', { class: 'xg-note' }, res.error));
      return;
    }

    // One shared slot for all three options: you pick a version, not three.
    // Defaulted to a free slot so saving can't fail on a collision you never
    // chose — every option used to land on the same time and the second lost.
    const slot = await nextFreeSlot();

    const dateInput = h('input', { class: 'xg-input', type: 'date', value: slot.date });
    const timeInput = h('input', { class: 'xg-input', type: 'time', value: slot.time });

    const when = () => ({
      date: dateInput.value,
      time: timeInput.value,
      timezone: localTimezone(),
    });

    output.replaceChildren(
      microLabel(`${res.data.options.length} versions`),
      h('div', { class: 'xg-opts' },
        ...res.data.options.map((text) => remixOptionCard(text, when))),
      field('When', h('div', { class: 'xg-when' }, dateInput, timeInput)),
    );

    output.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  generate.addEventListener('click', () => void run());
  setFooter(foot, generate, '⌘↵');
}

/**
 * The first slot from tomorrow 09:00 onwards that nothing already occupies.
 *
 * The schedule rejects two posts at the same instant, so defaulting every
 * option to a fixed time meant the first save won and the rest reported a
 * conflict the user never asked for.
 */
async function nextFreeSlot(): Promise<{ date: string; time: string }> {
  const res = await bg.schedule();
  const taken = new Set(res.ok ? res.data.map((post) => post.scheduled_at) : []);

  const when = new Date();
  when.setDate(when.getDate() + 1);
  when.setHours(9, 0, 0, 0);

  // A day and a half of hourly slots is far more than a schedule ever fills.
  for (let i = 0; i < 36; i++) {
    const date = dateKey(when);
    const time = timeKey(when);

    if (!taken.has(`${date}T${time}`)) return { date, time };

    when.setHours(when.getHours() + 1);
  }

  return { date: dateKey(when), time: timeKey(when) };
}

/**
 * A remix option. There is no composer open on a timeline, so "Insert" makes no
 * sense here — the useful destinations are the clipboard and the schedule.
 *
 * "Queue" approves the post as well as creating it, which is the whole point of
 * remixing something: you want it to go out, not to sit as a draft.
 */
function remixOptionCard(
  text: string,
  when: () => { date: string; time: string; timezone: string },
): HTMLElement {
  const copy = h('button', { class: 'xg-btn', type: 'button', textContent: 'Copy' });
  copy.addEventListener('click', () => {
    navigator.clipboard.writeText(text);
    copy.textContent = 'Copied';
    setTimeout(() => (copy.textContent = 'Copy'), 1200);
  });

  const note = h('span', { class: 'xg-saved' });

  /** Create the post, and approve it too when queueing. */
  const commit = async (
    button: HTMLButtonElement,
    label: string,
    queue: boolean,
  ) => {
    button.disabled = true;
    button.textContent = 'Saving…';
    note.textContent = '';

    const created = await bg.createPost({ content: text, category: null, ...when() });

    if (!created.ok) {
      button.disabled = false;
      button.textContent = label;
      // The real reason, not just "Failed" — a time collision is fixable and
      // the user can only fix what they can see.
      note.textContent = created.error;
      return;
    }

    if (queue) {
      const approved = await bg.approvePost(created.data);

      if (!approved.ok) {
        button.disabled = false;
        button.textContent = label;
        note.textContent = approved.error;
        return;
      }
    }

    button.textContent = queue ? 'Queued' : 'Saved';
    note.textContent = `${when().date} at ${when().time}`;
  };

  const draft = h('button', { class: 'xg-btn', type: 'button', textContent: 'Draft' });
  draft.addEventListener('click', () => void commit(draft, 'Draft', false));

  const queue = h('button', {
    class: 'xg-btn insert',
    type: 'button',
    textContent: 'Queue',
    title: 'Save it and approve it, so it posts automatically at that time',
  });
  queue.addEventListener('click', () => void commit(queue, 'Queue', true));

  return h(
    'div',
    { class: 'xg-opt' },
    h('p', { class: 'xg-opt-text', textContent: text }),
    h('div', { class: 'xg-opt-foot' }, counterFor(text, true),
      h('div', { class: 'xg-acts' }, copy, draft, queue)),
    note,
  );
}
