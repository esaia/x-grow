/**
 * X's design tokens, read off the live page.
 *
 * Everything we inject should look like it shipped with X, and X is not one
 * skin: there are three background themes (Default / Dim / Lights out) and six
 * accent colours the user picks in Settings → Display. Hard-coding "Twitter
 * blue on black" gets it wrong for most of those combinations, so the tokens
 * are *measured* instead — the page background and the sidebar Post button are
 * the ground truth, and everything else is derived from them.
 *
 * Read this fresh each time a surface is built (see `openPanel`) so a theme
 * switch is picked up without a reload.
 */

/** X's own defaults, used when a token can't be measured. */
const FALLBACK_ACCENT = 'rgb(29, 155, 240)';
const FALLBACK_BG = 'rgb(0, 0, 0)';

/**
 * X's font stack, written out rather than measured off `body`.
 *
 * Reading the computed value looked tidier but is a trap: whatever comes back
 * is dropped straight into a custom property, and if it doesn't resolve, the
 * `font-family` declaration is invalid at computed-value time and falls back
 * to the *initial* font. Inside the panel's `all: initial` shadow root that
 * initial font is a serif — which is exactly how the panel ended up rendering
 * in Times. Naming Chirp ourselves and ending in a generic family means the
 * worst case is the system sans, never a serif.
 */
export const FONT_STACK =
  '"TwitterChirp", "Segoe UI", Roboto, -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif';

export interface XTheme {
  /** True for the Dim and Lights-out themes. */
  dark: boolean;
  /** Page background — the surface panels and menus sit on. */
  bg: string;
  /** One step up from `bg`: inputs, cards, hover fills. */
  raise: string;
  /** Hover wash over a transparent control (X's standard icon-button hover). */
  hover: string;
  /** Hairline borders and dividers. */
  line: string;
  text: string;
  muted: string;
  /** The user's chosen accent: links, active icons, selected states. */
  accent: string;
  /** Accent at hover strength. */
  accentHover: string;
  /** Faint accent wash, for hover on accent-coloured icon buttons. */
  accentWash: string;
  /** Readable text/icon colour on top of `accent` (yellow needs black). */
  onAccent: string;
  /**
   * X's primary button fill — currently white on the dark themes and black on
   * the light one, which is *not* the accent colour. Measured separately so a
   * "Post"-weight button of ours matches the real one.
   */
  primary: string;
  primaryHover: string;
  onPrimary: string;
  /** Scrim behind a modal. */
  scrim: string;
  danger: string;
}

type Rgb = { r: number; g: number; b: number };

function parseRgb(value: string): Rgb | null {
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (!match) return null;

  const parts = match[1].split(/[,/\s]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;

  // Fully transparent tells us nothing about the colour.
  if (parts.length > 3 && parts[3] === 0) return null;

  return { r: parts[0], g: parts[1], b: parts[2] };
}

/** Perceived brightness, 0–1. */
function luminance({ r, g, b }: Rgb): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

const rgb = ({ r, g, b }: Rgb) => `rgb(${r}, ${g}, ${b})`;
const rgba = ({ r, g, b }: Rgb, alpha: number) => `rgba(${r}, ${g}, ${b}, ${alpha})`;

/** Mix `color` toward white (positive) or black (negative) by `amount` (0–1). */
function shade(color: Rgb, amount: number): Rgb {
  const target = amount > 0 ? 255 : 0;
  const t = Math.abs(amount);

  return {
    r: Math.round(color.r + (target - color.r) * t),
    g: Math.round(color.g + (target - color.g) * t),
    b: Math.round(color.b + (target - color.b) * t),
  };
}

/**
 * The first non-transparent background colour on `el` or inside it. X's Post
 * button is sometimes the styled element and sometimes a wrapper around one.
 */
function backgroundOf(el: Element | null): Rgb | null {
  if (!el) return null;

  const nodes = [el, ...el.querySelectorAll('*')].slice(0, 12);

  for (const node of nodes) {
    const color = parseRgb(getComputedStyle(node).backgroundColor);
    if (color) return color;
  }

  return null;
}

/**
 * The user's accent colour, taken from a tweet-body link — the one element
 * that is reliably painted in it. (The Post button is *not*: X fills it white
 * or black, and the composer's icons are grey.) Falls back to X's default
 * blue, which is what all but a handful of accounts are on anyway.
 */
function readAccent(): Rgb {
  const link = document.querySelector('[data-testid="tweetText"] a[role="link"]');
  const color = link ? parseRgb(getComputedStyle(link).color) : null;

  return color ?? parseRgb(FALLBACK_ACCENT)!;
}

/** Hover shade: X darkens its light fills and lightens its dark ones. */
function hoverOf(color: Rgb): Rgb {
  return shade(color, luminance(color) > 0.5 ? -0.1 : 0.12);
}

export function readXTheme(): XTheme {
  const body = document.body;
  const bodyStyle = body ? getComputedStyle(body) : null;

  const bg = parseRgb(bodyStyle?.backgroundColor ?? '') ??
    parseRgb(FALLBACK_BG)!;
  const dark = luminance(bg) < 0.5;

  const accent = readAccent();

  // X's own primary button, whatever colour they're painting it this month.
  const primary =
    backgroundOf(document.querySelector('[data-testid="SideNav_NewTweet_Button"]')) ??
    (dark ? { r: 239, g: 243, b: 244 } : { r: 15, g: 20, b: 25 });

  // X's palette: text #E7E9EA / #0F1419, secondary #71767B / #536471,
  // borders #2F3336 / #EFF3F4.
  const text = dark ? { r: 231, g: 233, b: 234 } : { r: 15, g: 20, b: 25 };
  const muted = dark ? { r: 113, g: 118, b: 123 } : { r: 83, g: 100, b: 113 };
  const line = dark ? { r: 47, g: 51, b: 54 } : { r: 239, g: 243, b: 244 };

  return {
    dark,
    bg: rgb(bg),
    // Lights-out is pure black, where a lift has to come from grey rather than
    // from the background itself.
    raise: rgb(shade(bg, dark ? 0.09 : -0.03)),
    hover: rgba(text, 0.1),
    line: rgb(line),
    text: rgb(text),
    muted: rgb(muted),
    accent: rgb(accent),
    accentHover: rgb(hoverOf(accent)),
    accentWash: rgba(accent, 0.1),
    onAccent: luminance(accent) > 0.65 ? 'rgb(15, 20, 25)' : 'rgb(255, 255, 255)',
    primary: rgb(primary),
    primaryHover: rgb(hoverOf(primary)),
    onPrimary: luminance(primary) > 0.65 ? 'rgb(15, 20, 25)' : 'rgb(255, 255, 255)',
    // X's own modal scrim, the same slate wash in every theme.
    scrim: 'rgba(91, 112, 131, 0.4)',
    danger: dark ? 'rgb(244, 33, 46)' : 'rgb(220, 30, 41)',
  };
}

/** The tokens as CSS custom properties, for a `style` block or inline style. */
export function themeVars(theme: XTheme): string {
  return `
    --xg-bg: ${theme.bg};
    --xg-raise: ${theme.raise};
    --xg-hover: ${theme.hover};
    --xg-line: ${theme.line};
    --xg-text: ${theme.text};
    --xg-muted: ${theme.muted};
    --xg-accent: ${theme.accent};
    --xg-accent-hover: ${theme.accentHover};
    --xg-accent-wash: ${theme.accentWash};
    --xg-on-accent: ${theme.onAccent};
    --xg-primary: ${theme.primary};
    --xg-primary-hover: ${theme.primaryHover};
    --xg-on-primary: ${theme.onPrimary};
    --xg-scrim: ${theme.scrim};
    --xg-danger: ${theme.danger};
  `;
}

/**
 * The ✨ mark. Drawn on X's 24px icon grid at their icon weight so it sits
 * evenly next to the composer's media/GIF/emoji icons.
 */
const SPARK_PATH =
  'M10.4 3.2c.45 4.3 1.9 5.75 6.2 6.2-4.3.45-5.75 1.9-6.2 6.2-.45-4.3-1.9-5.75-6.2-6.2 4.3-.45 5.75-1.9 6.2-6.2Z' +
  'M18 13.4c.28 2.4 1.02 3.14 3.4 3.4-2.38.26-3.12 1-3.4 3.4-.28-2.4-1.02-3.14-3.4-3.4 2.38-.26 3.12-1 3.4-3.4Z' +
  'M18.9 2.5c.16 1.36.58 1.78 1.94 1.94-1.36.16-1.78.58-1.94 1.94-.16-1.36-.58-1.78-1.94-1.94 1.36-.16 1.78-.58 1.94-1.94Z';

export function sparkSvg(size = 20): string {
  return (
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" ` +
    'aria-hidden="true" style="display:block"><path d="' +
    SPARK_PATH +
    '"/></svg>'
  );
}

/**
 * The remix mark: crossing arrows, on X's 24px grid at their stroke weight.
 *
 * Deliberately NOT the ✨ spark. The spark means "generate for me" and already
 * sits in the composer; a second spark in every tweet's action row would read
 * as the same button in a different place. Crossed arrows say "take this and
 * turn it into mine", which is what it does.
 */
export function remixSvg(size = 20): string {
  return (
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" ` +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true" style="display:block">' +
    '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>'
  );
}
