import { REPLY_OPTION_COUNT } from '@/lib/config';
import { bg } from '@/lib/messaging';
import { type ComposerContext, insertIntoEditor } from '@/lib/xdom';

const FALLBACK_TONES = [
  'balanced',
  'witty',
  'professional',
  'contrarian',
  'hype',
  'friendly',
  'funny',
];
const FORMATS = ['single', 'hook', 'thread'] as const;

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

const SPARK_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<path d="M12 2C12.5 7 17 11.5 22 12C17 12.5 12.5 17 12 22C11.5 17 7 12.5 2 12C7 11.5 12.5 7 12 2Z"/>' +
  '</svg>';

function spark(): HTMLElement {
  const s = h('span', { class: 'xg-spark' });
  s.innerHTML = SPARK_SVG;
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
  const dots = h('span', { class: 'xg-dots' });
  dots.innerHTML = '<i></i><i></i><i></i>';
  return h('div', { class: 'xg-loading' }, dots, h('span', { textContent: message }));
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

const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; font-family: ui-sans-serif, -apple-system, "SF Pro Text", "Segoe UI", Roboto, sans-serif; }

.xg-overlay {
  position: fixed; inset: 0; z-index: 2147483647;
  display: flex; align-items: center; justify-content: center;
  padding: 32px 16px;
  background: rgba(6,5,10,.62);
  backdrop-filter: blur(3px);
  opacity: 0;
  transition: opacity .16s ease-out;
}
.xg-overlay.is-open { opacity: 1; }
.xg-overlay.is-closing { opacity: 0; pointer-events: none; transition-duration: .13s; }

.xg-panel {
  --ink: #100F14;
  --raise: #1A1822;
  --raise-2: #232029;
  --line: rgba(255,255,255,.09);
  --text: #F4F1EA;
  --muted: #968FA3;
  --amber: #F6B44C;
  --amber-2: #EA9A38;
  --danger: #FF7A6B;

  position: relative;
  width: 100%; max-width: 560px;
  max-height: 100%; min-height: 0;
  background: var(--ink); color: var(--text);
  border: 1px solid var(--line); border-radius: 18px;
  box-shadow: 0 24px 64px -16px rgba(0,0,0,.7), 0 2px 8px rgba(0,0,0,.4);
  overflow: hidden; font-size: 14px;
  display: flex; flex-direction: column;
  opacity: 0; transform: translateY(10px) scale(.98);
  transition: opacity .16s ease-out, transform .18s cubic-bezier(.2,.8,.25,1);
}
.xg-overlay.is-open .xg-panel { opacity: 1; transform: none; }
.xg-overlay.is-closing .xg-panel {
  opacity: 0; transform: translateY(6px) scale(.985);
  transition-duration: .13s;
}
@keyframes xg-in { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }

.xg-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 13px 15px; border-bottom: 1px solid rgba(255,255,255,.06);
  flex: 0 0 auto;
}
.xg-head-acts { display: flex; align-items: center; gap: 8px; }
.xg-esc {
  font-family: ui-monospace, "SF Mono", monospace; font-size: 10.5px; color: var(--muted);
  border: 1px solid var(--line); border-radius: 7px; padding: 3px 7px; line-height: 1;
}
.xg-brand { display: flex; align-items: center; gap: 8px; }
.xg-spark { display: inline-flex; color: var(--amber); filter: drop-shadow(0 0 7px rgba(246,180,76,.5)); }
.xg-spark svg { width: 17px; height: 17px; display: block; }
.xg-title { font-weight: 700; font-size: 15px; letter-spacing: -.01em; }
.xg-x { all: unset; cursor: pointer; color: var(--muted); width: 27px; height: 27px;
  display: grid; place-items: center; border-radius: 8px; font-size: 15px; line-height: 1; }
.xg-x:hover { background: var(--raise); color: var(--text); }
.xg-x:focus-visible { box-shadow: 0 0 0 3px rgba(246,180,76,.3); }

.xg-body { padding: 15px; display: flex; flex-direction: column; gap: 16px;
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.22) transparent; }
.xg-body::-webkit-scrollbar { width: 10px; }
.xg-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,.2);
  border-radius: 8px; border: 3px solid transparent; background-clip: padding-box; }
.xg-body::-webkit-scrollbar-track { background: transparent; }

.xg-label {
  font-family: ui-monospace, "SF Mono", "JetBrains Mono", monospace;
  font-size: 10.5px; letter-spacing: .15em; text-transform: uppercase;
  color: var(--muted); margin-bottom: 9px;
}

/* The post being replied to stays pinned while the options scroll under it —
   once results render, the inputs are otherwise scrolled off the top and you
   lose sight of what the replies are answering. Negative margins let it span
   the body's padding so scrolled content never peeks through the gap. */
.xg-sticky {
  position: sticky; top: 0; z-index: 2;
  margin: -15px -15px 0; padding: 15px 15px 13px;
  background: var(--ink);
  border-bottom: 1px solid rgba(255,255,255,.06);
}

.xg-context-wrap { display: flex; flex-direction: column; align-items: flex-start; gap: 7px; }
.xg-context { display: flex; flex-direction: column; gap: 8px; align-self: stretch; }
/* Expanded posts can be long — cap the pinned block and let it scroll rather
   than pushing the replies off screen. */
.xg-context.is-expanded { max-height: 220px; overflow-y: auto; padding-right: 4px;
  scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.22) transparent; }
.xg-more {
  all: unset; box-sizing: border-box; cursor: pointer;
  font-size: 12px; font-weight: 600; color: var(--amber);
  padding: 2px 0; margin-left: 14px;
}
.xg-more:hover { text-decoration: underline; }
.xg-more:focus-visible { box-shadow: 0 0 0 3px rgba(246,180,76,.3); border-radius: 6px; }

.xg-context-role {
  font-size: 9.5px; letter-spacing: .12em; text-transform: uppercase;
  color: var(--muted); margin-bottom: -4px;
}
.xg-quote {
  font-size: 13px; line-height: 1.5; color: #C9C3D2;
  border-left: 2px solid var(--amber); padding: 1px 0 1px 12px;
  overflow: hidden; overflow-wrap: anywhere;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3;
}
.xg-quote.is-parent {
  color: var(--muted); border-left-color: var(--line);
  -webkit-line-clamp: 2;
}
.xg-context.is-expanded .xg-quote { -webkit-line-clamp: unset; }

.xg-input {
  width: 100%; font: inherit; font-size: 14px; color: var(--text);
  background: var(--raise); border: 1px solid var(--line); border-radius: 12px;
  padding: 11px 12px; resize: vertical; min-height: 78px; line-height: 1.5;
}
.xg-input::placeholder { color: var(--muted); }
.xg-input:focus { outline: none; border-color: rgba(246,180,76,.55);
  box-shadow: 0 0 0 3px rgba(246,180,76,.15); }

.xg-chips { display: flex; flex-wrap: wrap; gap: 7px; }
.xg-chip {
  all: unset; box-sizing: border-box; cursor: pointer;
  font-size: 13px; font-weight: 550; color: var(--muted);
  background: var(--raise); border: 1px solid var(--line);
  padding: 6px 13px; border-radius: 999px; text-transform: capitalize;
  transition: color .12s, background .12s, border-color .12s;
}
.xg-chip:hover { color: var(--text); border-color: rgba(255,255,255,.2); }
.xg-chip.is-active {
  color: #1C1206; font-weight: 650; border-color: transparent;
  background: linear-gradient(180deg, var(--amber), var(--amber-2));
}
.xg-chip:focus-visible { box-shadow: 0 0 0 3px rgba(246,180,76,.3); }

.xg-foot {
  flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between;
  gap: 12px; padding: 12px 15px; border-top: 1px solid rgba(255,255,255,.06);
  background: rgba(255,255,255,.015);
}
.xg-foot:empty { display: none; }
.xg-hint {
  font-family: ui-monospace, "SF Mono", monospace; font-size: 11px; color: var(--muted);
}

.xg-generate {
  all: unset; box-sizing: border-box; cursor: pointer; text-align: center;
  margin-left: auto; padding: 11px 22px; border-radius: 12px;
  font-weight: 700; font-size: 14.5px; letter-spacing: -.01em; color: #1C1206;
  background: linear-gradient(180deg, var(--amber), var(--amber-2));
  box-shadow: 0 8px 20px -8px rgba(246,180,76,.55);
  transition: filter .12s, transform .05s;
}
.xg-generate:hover { filter: brightness(1.05); }
.xg-generate:active { transform: translateY(1px); }
.xg-generate:focus-visible { box-shadow: 0 0 0 3px rgba(246,180,76,.35); }
.xg-generate:disabled { opacity: .5; cursor: not-allowed; box-shadow: none; }

.xg-output:empty { display: none; }
.xg-output:not(:empty) {
  border-top: 1px dashed var(--line); padding-top: 15px;
  animation: xg-in .16s ease-out;
}

.xg-recent {
  border-top: 1px dashed var(--line); padding-top: 15px;
  display: flex; flex-direction: column; gap: 14px;
  animation: xg-in .14s ease-out;
}
.xg-recent > .xg-label { margin-bottom: 0; color: var(--amber); }
.xg-recent-batch .xg-label { margin-bottom: 8px; }
.xg-recent .xg-opt { background: transparent; }

.xg-opts { display: flex; flex-direction: column; gap: 10px; }
.xg-opt {
  background: var(--raise); border: 1px solid var(--line);
  border-radius: 14px; padding: 12px; transition: border-color .12s;
}
.xg-opt:hover { border-color: rgba(246,180,76,.4); }
.xg-opt-text { margin: 0 0 11px; white-space: pre-wrap; line-height: 1.5; font-size: 14px; }
.xg-opt-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.xg-count { font-family: ui-monospace, "SF Mono", monospace; font-size: 11px; color: var(--muted); }
.xg-count.over { color: var(--danger); }
.xg-acts { display: flex; gap: 6px; }
.xg-btn {
  all: unset; box-sizing: border-box; cursor: pointer;
  font-size: 12.5px; font-weight: 600; padding: 6px 13px; border-radius: 9px;
  border: 1px solid var(--line); color: var(--text); background: transparent;
}
.xg-btn:hover { background: var(--raise-2); }
.xg-btn:focus-visible { box-shadow: 0 0 0 3px rgba(246,180,76,.3); }
.xg-btn.insert {
  color: #1C1206; font-weight: 650; border-color: transparent;
  background: linear-gradient(180deg, var(--amber), var(--amber-2));
}
.xg-btn.insert:hover { filter: brightness(1.05); background: linear-gradient(180deg, var(--amber), var(--amber-2)); }

.xg-regen {
  all: unset; box-sizing: border-box; cursor: pointer; text-align: center;
  margin-left: auto; padding: 10px 20px; border-radius: 11px; font-size: 13px; font-weight: 600;
  color: var(--muted); border: 1px solid var(--line);
}
.xg-regen:hover { color: var(--text); background: var(--raise); }
.xg-regen:focus-visible { box-shadow: 0 0 0 3px rgba(246,180,76,.3); }

.xg-note { color: var(--muted); font-size: 13px; line-height: 1.55; margin: 2px 0; }
.xg-err { color: var(--danger); font-size: 13px; line-height: 1.5; margin: 0; }

.xg-loading { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 13px; padding: 12px 0; }
.xg-dots { display: inline-flex; gap: 4px; }
.xg-dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--amber);
  animation: xg-bounce 1s infinite ease-in-out; }
.xg-dots i:nth-child(2) { animation-delay: .15s; }
.xg-dots i:nth-child(3) { animation-delay: .3s; }
@keyframes xg-bounce { 0%,60%,100% { transform: translateY(0); opacity: .45; } 30% { transform: translateY(-5px); opacity: 1; } }

@media (prefers-reduced-motion: reduce) {
  .xg-overlay, .xg-panel { transition: none; }
  .xg-panel { transform: none; }
  .xg-recent { animation: none; }
  .xg-dots i { animation: none; }
}
`;

export function openPanel(ctx: ComposerContext): void {
  closePanel(true);

  const host = document.createElement('div');
  host.setAttribute('data-xgrow-panel', '');
  openHost = host;

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.append(h('style', { textContent: STYLE }));

  const isReply = ctx.mode === 'reply';
  const body = h('div', { class: 'xg-body' });
  const foot = h('div', { class: 'xg-foot' });

  const closeBtn = h('button', { class: 'xg-x', type: 'button', textContent: '✕', title: 'Close' });
  // Wrapped: passing the listener directly would hand the event to `immediate`.
  closeBtn.addEventListener('click', () => closePanel());

  const panel = h(
    'div',
    { class: 'xg-panel' },
    h(
      'div',
      { class: 'xg-head' },
      h('div', { class: 'xg-brand' }, spark(), h('span', {
        class: 'xg-title',
        textContent: isReply ? 'AI reply' : 'AI post',
      })),
      h('div', { class: 'xg-head-acts' },
        h('span', { class: 'xg-esc', textContent: 'esc' }), closeBtn),
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

  renderInputs({ body, foot }, ctx, isReply);
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

  const auth = await bg.getAuth();
  if (!auth.ok) {
    body.replaceChildren(h('p', { class: 'xg-note' }, auth.error));
    return;
  }
  if (!auth.data.connected) {
    body.replaceChildren(
      h('p', { class: 'xg-note' },
        'Open the X-Grow icon in your toolbar and paste your token to start generating.'),
    );
    return;
  }

  const tones = auth.data.me?.options.tones ?? FALLBACK_TONES;
  const defaultTone = auth.data.me?.voice_profile?.tone ?? 'balanced';

  const toneGroup = chipGroup(tones, defaultTone, 'Tone');

  let topic: HTMLTextAreaElement | null = null;
  let formatGroup: { el: HTMLElement; get: () => string } | null = null;

  const controls: HTMLElement[] = [];

  if (isReply) {
    controls.push(field('Replying to', replyContext(ctx), 'xg-sticky'));
    controls.push(field('Tone', toneGroup.el));
  } else {
    topic = h('textarea', {
      class: 'xg-input',
      placeholder: "What's this post about? A topic, a link, or a rough idea.",
    });
    formatGroup = chipGroup(FORMATS, 'single', 'Format');
    controls.push(field('Topic', topic));
    controls.push(field('Format', formatGroup.el));
    controls.push(field('Tone', toneGroup.el));
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
  // replying to and the tone you picked stay on screen so a regenerate is one
  // click away with a different tone.
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

    const tone = toneGroup.get();
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
  const total = gens.reduce((n, g) => n + g.options.length, 0);

  // One labelled group per generation batch (newest first), so each batch keeps
  // its own timestamp/tone context instead of blurring 6 replies into one list.
  const groups = gens.map((gen) => {
    const when = relativeTime(gen.created_at);
    const tone = gen.meta?.tone;
    const cards = gen.options.map((text) => optionCard(ctx, text, true));
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
