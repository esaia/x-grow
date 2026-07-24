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
let cleanup: (() => void) | null = null;

function closePanel() {
  cleanup?.();
  cleanup = null;
  openHost?.remove();
  openHost = null;
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

function field(label: string, control: Node): HTMLElement {
  return h('div', { class: 'xg-field' }, microLabel(label), control);
}

// The conversation the reply lands in: the original post (and any intermediate
// tweets) followed by the immediate comment. Showing the whole thread — not
// only the comment — makes clear the AI has the post as context too.
function replyContext(ctx: ComposerContext): HTMLElement {
  const tweets = ctx.contextTweets.length ? ctx.contextTweets : [ctx.tweet];
  const wrap = h('div', { class: 'xg-context' });
  tweets.forEach((text, i) => {
    const last = i === tweets.length - 1;
    if (tweets.length > 1) {
      wrap.append(h('div', {
        class: 'xg-context-role',
        textContent: last ? 'Comment' : i === 0 ? 'Original post' : 'Earlier reply',
      }));
    }
    wrap.append(h('div', {
      class: 'xg-quote' + (last ? '' : ' is-parent'),
      textContent: text,
    }));
  });
  return wrap;
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

  position: relative; z-index: 2147483647;
  width: 384px; max-width: calc(100vw - 24px);
  background: var(--ink); color: var(--text);
  border: 1px solid var(--line); border-radius: 18px;
  box-shadow: 0 24px 64px -16px rgba(0,0,0,.7), 0 2px 8px rgba(0,0,0,.4);
  overflow: hidden; font-size: 14px;
  display: flex; flex-direction: column;
  animation: xg-in .14s ease-out;
}
@keyframes xg-in { from { opacity: 0; transform: translateY(5px) scale(.99); } to { opacity: 1; transform: none; } }

.xg-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 13px 15px; border-bottom: 1px solid rgba(255,255,255,.06);
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

.xg-context { display: flex; flex-direction: column; gap: 8px; }
.xg-context-role {
  font-size: 9.5px; letter-spacing: .12em; text-transform: uppercase;
  color: var(--muted); margin-bottom: -4px;
}
.xg-quote {
  font-size: 13px; line-height: 1.5; color: #C9C3D2;
  border-left: 2px solid var(--amber); padding: 1px 0 1px 12px;
  max-height: 66px; overflow: hidden;
}
.xg-quote.is-parent {
  color: var(--muted); border-left-color: var(--line);
  max-height: 48px;
}

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

.xg-generate {
  all: unset; box-sizing: border-box; cursor: pointer; text-align: center;
  width: 100%; padding: 12px; border-radius: 12px;
  font-weight: 700; font-size: 14.5px; letter-spacing: -.01em; color: #1C1206;
  background: linear-gradient(180deg, var(--amber), var(--amber-2));
  box-shadow: 0 8px 20px -8px rgba(246,180,76,.55);
  transition: filter .12s, transform .05s;
}
.xg-generate:hover { filter: brightness(1.05); }
.xg-generate:active { transform: translateY(1px); }
.xg-generate:focus-visible { box-shadow: 0 0 0 3px rgba(246,180,76,.35); }
.xg-generate:disabled { opacity: .5; cursor: not-allowed; box-shadow: none; }

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
  width: 100%; padding: 10px; border-radius: 11px; font-size: 13px; font-weight: 600;
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
  .xg-panel { animation: none; }
  .xg-dots i { animation: none; }
}
`;

export function openPanel(anchor: HTMLElement, ctx: ComposerContext): void {
  closePanel();

  const host = document.createElement('div');
  host.setAttribute('data-xgrow-panel', '');
  openHost = host;

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.append(h('style', { textContent: STYLE }));

  const isReply = ctx.mode === 'reply';
  const body = h('div', { class: 'xg-body' });

  const closeBtn = h('button', { class: 'xg-x', type: 'button', textContent: '✕', title: 'Close' });
  closeBtn.addEventListener('click', closePanel);

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
      closeBtn,
    ),
    body,
  );
  shadow.append(panel);

  // Render in the top layer (no clipping) and keep the panel glued to the
  // button by re-tracking its position on every scroll/resize. This behaves
  // like an anchored popover: it moves *with* the button, so there's never a
  // gap, regardless of which of X's containers actually scrolls.
  document.body.appendChild(host);
  host.style.position = 'fixed';
  host.style.zIndex = '2147483647';

  // Keep clicks inside the panel from leaking into X's composer handlers.
  host.addEventListener('mousedown', (e) => e.stopPropagation());
  host.addEventListener('click', (e) => e.stopPropagation());

  const margin = 12;
  const reposition = () => {
    // If the composer (and its button) is gone from the page, close.
    if (!anchor.isConnected) {
      closePanel();
      return;
    }
    const aRect = anchor.getBoundingClientRect();
    const leftVp = Math.max(margin, Math.min(aRect.left, window.innerWidth - 384 - margin));
    host.style.left = `${leftVp}px`;

    const spaceBelow = window.innerHeight - aRect.bottom - margin;
    const spaceAbove = aRect.top - margin;
    const placeBelow = spaceBelow >= 320 || spaceBelow >= spaceAbove;
    panel.style.maxHeight = `${Math.max(200, placeBelow ? spaceBelow : spaceAbove)}px`;

    if (placeBelow) {
      host.style.top = `${aRect.bottom + 8}px`;
    } else {
      host.style.top = `${aRect.top - host.offsetHeight - 8}px`;
    }
  };
  reposition();

  // Track scroll (capture:true also catches X's inner scroll containers) + resize.
  let rafId = 0;
  const onMove = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      reposition();
    });
  };
  window.addEventListener('scroll', onMove, { capture: true, passive: true });
  window.addEventListener('resize', onMove);

  // Dismiss on outside click / Escape.
  const onDocClick = (e: MouseEvent) => {
    if (!host.contains(e.target as Node)) closePanel();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closePanel();
  };
  setTimeout(() => document.addEventListener('click', onDocClick), 0);
  document.addEventListener('keydown', onKey);
  cleanup = () => {
    if (rafId) cancelAnimationFrame(rafId);
    window.removeEventListener('scroll', onMove, { capture: true } as EventListenerOptions);
    window.removeEventListener('resize', onMove);
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onKey);
  };

  renderInputs(body, ctx, isReply);
}

async function renderInputs(
  body: HTMLElement,
  ctx: ComposerContext,
  isReply: boolean,
) {
  body.replaceChildren(loading('Loading your voice…'));

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
    controls.push(field('Replying to', replyContext(ctx)));
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
    textContent: isReply ? 'Write 3 replies' : 'Write 3 posts',
  });

  generate.addEventListener('click', async () => {
    if (!isReply && !topic?.value.trim()) {
      topic?.focus();
      return;
    }

    body.replaceChildren(loading(isReply ? 'Writing your replies…' : 'Writing your posts…'));

    const tone = toneGroup.get();
    const res = isReply
      ? await bg.reply({
          tweet: ctx.tweet,
          thread_context: ctx.threadContext || undefined,
          tone,
        })
      : await bg.post({
          topic: topic!.value.trim(),
          format: formatGroup!.get() as 'single' | 'hook' | 'thread',
          tone,
        });

    if (!res.ok) {
      showError(body, ctx, isReply, res.error);
      return;
    }

    const enforce280 = isReply || formatGroup!.get() !== 'thread';
    renderResults(body, ctx, isReply, res.data.options, enforce280);
  });

  controls.push(generate);
  body.replaceChildren(...controls);

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

  // Slot it just above the "Write replies" button.
  const generate = body.querySelector('.xg-generate');
  if (generate) body.insertBefore(section, generate);
  else body.append(section);
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
  body: HTMLElement,
  ctx: ComposerContext,
  isReply: boolean,
  options: string[],
  enforce280: boolean,
) {
  const cards = options.map((text) => optionCard(ctx, text, enforce280));

  const regen = h('button', { class: 'xg-regen', type: 'button', textContent: 'Regenerate' });
  regen.addEventListener('click', () => renderInputs(body, ctx, isReply));

  body.replaceChildren(
    microLabel('Pick one to insert'),
    h('div', { class: 'xg-opts' }, ...cards),
    regen,
  );
}

function showError(
  body: HTMLElement,
  ctx: ComposerContext,
  isReply: boolean,
  message: string,
) {
  const retry = h('button', { class: 'xg-regen', type: 'button', textContent: 'Try again' });
  retry.addEventListener('click', () => renderInputs(body, ctx, isReply));
  body.replaceChildren(h('p', { class: 'xg-err', textContent: message }), retry);
}
