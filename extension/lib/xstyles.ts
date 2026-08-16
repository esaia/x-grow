import { FONT_STACK, readXTheme, themeVars, type XTheme } from '@/lib/xtheme';

/**
 * Styling for the controls we inject into x.com itself (the composer's ✨
 * button, the profile-page pills, the toast).
 *
 * Delivered as a *constructed* stylesheet rather than a `<style>` tag: X ships
 * a strict CSP, and adopted stylesheets are CSSOM objects rather than page
 * content, so they apply without needing `style-src 'unsafe-inline'`. It also
 * buys us real `:hover`/`:focus-visible` states, which inline styles can't do.
 *
 * The panel has its own copy of the tokens inside its shadow root — see
 * `panel.ts`.
 */

let sheet: CSSStyleSheet | null = null;
let applied: XTheme | null = null;
let theme: XTheme = readXTheme();

/** How often to re-read X's tokens, so a theme switch is picked up live. */
const THEME_POLL_MS = 5000;

function css(t: XTheme): string {
  return `
:root { ${themeVars(t)} }

/* X's icon buttons: a 34.75px round target, accent-coloured glyph, and a faint
   accent wash on hover. Matching those numbers is what makes ours read as one
   of the composer's own controls rather than a bolted-on pill. */
.xg-icon-btn {
  all: unset;
  box-sizing: border-box;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 34.75px;
  height: 34.75px;
  margin: 0 2px;
  border-radius: 9999px;
  color: var(--xg-accent);
  background-color: transparent;
  transition: background-color .2s;
}
.xg-icon-btn:hover { background-color: var(--xg-accent-wash); }
.xg-icon-btn:focus-visible { box-shadow: 0 0 0 2px var(--xg-accent); }
.xg-icon-btn[disabled] { opacity: .5; cursor: default; }
/* The all:unset above wipes the UA's [hidden] rule, and the explicit
   display:inline-flex then wins over it — so hiding the polish button (it only
   applies once there is a draft) needs this said again here. */
.xg-icon-btn[hidden] { display: none; }
.xg-icon-btn svg { width: 20px; height: 20px; display: block; }

/* X's secondary (outlined) button — used for the profile-page actions, which
   sit in a row with Follow and "⋯" and have to match their height. */
.xg-pill {
  all: unset;
  box-sizing: border-box;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex: 0 0 auto;
  min-width: 0;
  align-self: center;
  height: 36px;
  padding: 0 16px;
  margin-right: 8px;
  border: 1px solid var(--xg-line);
  border-radius: 9999px;
  color: var(--xg-text);
  background-color: transparent;
  font-family: ${FONT_STACK};
  font-size: 15px;
  font-weight: 700;
  line-height: 1;
  white-space: nowrap;
  transition: background-color .2s;
}
.xg-pill:hover { background-color: var(--xg-hover); }
.xg-pill:focus-visible { box-shadow: 0 0 0 2px var(--xg-accent); }
.xg-pill[disabled] { opacity: .5; cursor: default; }
.xg-pill svg { width: 18px; height: 18px; display: block; color: var(--xg-accent); }

.xg-pill.xg-floating {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 2147483646;
  height: 44px;
  padding: 0 20px;
  margin: 0;
  border-color: transparent;
  color: var(--xg-on-primary);
  background-color: var(--xg-primary);
  box-shadow: 0 8px 28px rgba(0,0,0,.35);
}
.xg-pill.xg-floating:hover { background-color: var(--xg-primary-hover); }
.xg-pill.xg-floating svg { color: currentColor; }

/* The remix button in a tweet's action row. That row is a flex line whose
   buttons are 34.75px like the composer's, but it sits tighter and the glyphs
   are muted until hovered — matching that is what stops it reading as a badge
   stuck onto someone else's post. */
.xg-remix-btn {
  width: 32px;
  height: 32px;
  margin: 0;
  color: var(--xg-muted);
}
.xg-remix-btn:hover { color: var(--xg-accent); background-color: var(--xg-accent-wash); }
.xg-remix-btn svg { width: 18px; height: 18px; }

/* X's own toast: a pill pinned bottom-centre, filled in the accent colour. */
.xg-toast {
  position: fixed;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%);
  z-index: 2147483647;
  max-width: 380px;
  padding: 12px 16px;
  border-radius: 4px;
  color: var(--xg-on-accent);
  background-color: var(--xg-accent);
  font-family: ${FONT_STACK};
  font-size: 15px;
  font-weight: 400;
  line-height: 1.3;
  box-shadow: 0 8px 28px rgba(0,0,0,.35);
}
.xg-toast.is-error { color: #fff; background-color: var(--xg-danger); }
`;
}

/**
 * Make sure the injected controls are styled, and keep them in step with the
 * theme X is currently showing. Called from every DOM scan, so the no-op path
 * is a single reference comparison — no string building, no style reads.
 */
export function ensureStyles(): void {
  if (!sheet) {
    sheet = new CSSStyleSheet();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    setInterval(refreshTheme, THEME_POLL_MS);
  }

  if (applied === theme) return;

  applied = theme;
  sheet.replaceSync(css(theme));
}

function refreshTheme(): void {
  const next = readXTheme();

  // Only touch the stylesheet when something actually changed, so the 5s tick
  // costs one style read and nothing else.
  if (
    next.bg !== theme.bg ||
    next.accent !== theme.accent ||
    next.primary !== theme.primary ||
    next.text !== theme.text
  ) {
    theme = next;
    ensureStyles();
  }
}
