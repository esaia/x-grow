/**
 * HTML for the admin panel. `html` is a tagged template that escapes every
 * interpolated value unless it is itself `html` (or `raw`), so captions,
 * comments and usernames from Instagram can never inject markup.
 *
 * The panel is plain server-rendered HTML + forms. Its only script is
 * /admin.js (busy states on submit), loaded from our own origin: the CSP
 * allows 'self' and nothing inline, and every form works without it.
 *
 * Visual language: llamapresenter.com's dark site theme (its `site-*`
 * tokens, Geist, pill buttons, floating blurred nav, 28px glow panels).
 */

const SAFE = Symbol("safe-html");

export interface SafeHtml {
  [SAFE]: true;
  value: string;
}

type Value = SafeHtml | string | number | boolean | null | undefined | Value[];

export function raw(value: string): SafeHtml {
  return { [SAFE]: true, value };
}

export function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function render(v: Value): string {
  if (v === null || v === undefined || v === false) return "";
  if (Array.isArray(v)) return v.map(render).join("");
  if (typeof v === "object" && SAFE in v) return v.value;
  return escape(String(v));
}

export function html(strings: TemplateStringsArray, ...values: Value[]): SafeHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return raw(out);
}

const CSP = [
  "default-src 'none'",
  "img-src https: data:",
  "font-src 'self'",
  "script-src 'self'",
  "style-src 'unsafe-inline'",
  "form-action 'self' https://www.facebook.com",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

/** The product mark: a cream plate with an ink speech bubble and a yellow reply dot. */
export const MARK = raw(`<svg class="mark" viewBox="0 0 40 40" aria-hidden="true">
<rect width="40" height="40" rx="11" fill="#fdf7e8"/>
<path d="M11 13.5a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v7a4 4 0 0 1-4 4h-6.2l-4.6 3.9c-.6.5-1.2.1-1.2-.6V24.4A4 4 0 0 1 11 20.5z" fill="#191818"/>
<circle cx="27.5" cy="25.5" r="5" fill="#fcdf50" stroke="#fdf7e8" stroke-width="2"/>
</svg>`);

export function page(
  title: string,
  body: SafeHtml,
  opts: { status?: number; nav?: boolean; flash?: string; headers?: HeadersInit; section?: string } = {},
): Response {
  const nav = opts.nav !== false;
  const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="dark">
<title>${title} – Social Manager</title>
<link rel="preload" href="/fonts/GeistVar-latin.woff2" as="font" type="font/woff2" crossorigin>
<style>${raw(CSS)}</style>
<script src="/admin.js" defer></script>
</head>
<body>
${nav
    ? html`<header class="top"><nav class="pill-nav" aria-label="Main">
  <a class="brand" href="/admin">${MARK}<span>Social Manager</span></a>
  ${(["instagram", "facebook"] as const).map(
    (n) => html`<a class="nav-link${opts.section === n ? " is-current" : ""}" href="/admin/${n}"${
      opts.section === n ? raw(' aria-current="page"') : ""
    }>${n === "instagram" ? "Instagram" : "Facebook"}</a>`,
  )}
  <span class="grow"></span>
  <!--sm:viewer-->
  <form method="post" action="/admin/logout"><button class="nav-link">Log out</button></form>
</nav></header>`
    : ""}
<main class="${nav ? "wrap" : "wrap bare"}">
${opts.flash ? html`<p class="flash" role="status"><span class="dot dot-on"></span>${opts.flash}</p>` : ""}
${body}
</main>
</body>
</html>`;
  const headers = new Headers(opts.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", CSP);
  headers.set("X-Content-Type-Options", "nosniff");
  // same-origin, not no-referrer: under no-referrer, form POSTs carry
  // `Origin: null` and fail the same-origin check. Instagram images still
  // get no referrer (referrerpolicy on the <img> tags).
  headers.set("Referrer-Policy", "same-origin");
  return new Response(doc.value, { status: opts.status ?? 200, headers });
}

/** The viewer's links in the nav ("People" for owners, their name → My account). Filled in by the router. */
export const VIEWER_SLOT = "<!--sm:viewer-->";
export function viewerNav(v: { name: string; owner: boolean }, path: string): string {
  const link = (href: string, label: string) =>
    html`<a class="nav-link${path.startsWith(href) ? " is-current" : ""}" href="${href}">${label}</a>`.value;
  return (v.owner ? link("/admin/users", "People") : "") + link("/admin/account", v.name);
}

export function redirect(location: string, headers: HeadersInit = {}): Response {
  const h = new Headers(headers);
  h.set("Location", location);
  return new Response(null, { status: 303, headers: h });
}

/** "24 Nov 2026, 15:28 UTC" (stored times are UTC ISO strings). */
export function when(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return `${date}, ${d.toISOString().slice(11, 16)} UTC`;
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

/** 16px stroke icons, inherit currentColor. */
export const icon = {
  arrowLeft: raw(`<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5"/></svg>`),
  external: raw(`<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5h6.5V10M12.5 3.5 4 12"/></svg>`),
  plus: raw(`<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>`),
  dm: raw(`<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v7.5h-6l-3 2.5V11h-2z"/></svg>`),
  reply: raw(`<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 4 3 7.5 6.5 11M3 7.5h6.5a3.5 3.5 0 0 1 3.5 3.5v1"/></svg>`),
  play: raw(`<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7-4.5z"/></svg>`),
  heart: raw(`<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13s-5-3-5-6.8A2.7 2.7 0 0 1 8 4.7a2.7 2.7 0 0 1 5 1.5C13 10 8 13 8 13z"/></svg>`),
  comment: raw(`<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 7.5a5.5 5 0 0 1-8 4.4L2.5 13l1-2.6a5 5 0 0 1-1-2.9 5.5 5 0 0 1 11 0z"/></svg>`),
};

const compactFmt = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
/** 1234 → "1.2K". */
export function compact(n: number | null | undefined): string {
  return n === null || n === undefined ? "–" : compactFmt.format(n);
}

const CSS = `
@font-face{font-family:"Geist Var";src:url(/fonts/GeistVar-latin.woff2) format("woff2");font-weight:100 900;font-display:swap;
unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"Geist Var";src:url(/fonts/GeistVar-latin-ext.woff2) format("woff2");font-weight:100 900;font-display:swap;
unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}

:root{
  --bg:#000;--band:#0a0a0b;--surface:#0f0f10;--rule:#1c1d1f;--ink:#fafafa;--muted:#888b91;--faint:#70757c;
  --accent:#fcdf50;--onaccent:#191818;--glow:#f5a524;--cream:#fdf7e8;--on:#3ed17e;--danger:#f2564b;
  --field:#0f0f10;--field-hover:#141416;
  --frame:0 40px 80px -32px #000000d9,0 0 0 1px #ffffff14;
  --ease:cubic-bezier(.22,1,.36,1);
  color-scheme:dark;
}
*{box-sizing:border-box}
html{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
body{margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.55 "Geist Var",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans Georgian",sans-serif;
  font-feature-settings:"ss01"}
a{color:inherit;text-decoration:none}
img{display:block;max-width:100%}
.i{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;flex:none}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:8px}

/* ── nav: the floating blurred pill from llamapresenter.com ─────────────── */
.top{position:fixed;inset:12px 0 auto;z-index:50;display:flex;justify-content:center;padding:0 16px}
.pill-nav{display:flex;align-items:center;gap:4px;width:100%;max-width:1120px;padding:4px 4px 4px 10px;border-radius:9999px;
  background:#141416b3;-webkit-backdrop-filter:blur(20px) saturate(150%);backdrop-filter:blur(20px) saturate(150%);
  box-shadow:0 10px 30px -10px #0009,inset 0 0 0 1px #ffffff1a}
.brand{display:inline-flex;align-items:center;gap:9px;height:36px;margin-right:10px;font-weight:650;letter-spacing:-.02em;font-size:15.5px}
.mark{width:26px;height:26px;flex:none}
.nav-link{display:inline-flex;align-items:center;height:36px;padding:0 14px;border-radius:9999px;border:0;background:none;
  color:color-mix(in oklab,var(--ink) 60%,transparent);font:inherit;font-size:14.5px;font-weight:500;cursor:pointer;
  transition:color .15s,background-color .15s}
.nav-link:hover{color:var(--ink)}
.nav-link.is-current{color:var(--ink);background:#ffffff12}
.grow{flex:1}

/* ── layout ─────────────────────────────────────────────────────────────── */
.wrap{max-width:1120px;margin:0 auto;padding:104px 24px 96px}
.wrap.bare{padding-top:0}
.crumb{display:inline-flex;align-items:center;gap:6px;color:var(--muted);font-size:14px;margin-bottom:22px;transition:color .15s}
.crumb:hover{color:var(--ink)}
.head{display:flex;align-items:flex-end;gap:20px;flex-wrap:wrap;margin-bottom:40px}
.head > div:first-child{flex:1;min-width:min(260px,100%)}
h1{margin:0;font-size:clamp(2.1rem,4.6vw,3.25rem);line-height:1.04;font-weight:800;letter-spacing:-.045em}
.lede{margin:14px 0 0;max-width:60ch;color:var(--muted);font-size:17px;line-height:1.5}
h2{margin:0;font-size:21px;font-weight:700;letter-spacing:-.025em}
.section{margin-top:64px}
.section-head{display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;margin-bottom:18px}
.section-head p{margin:0;color:var(--muted);font-size:14px}
.muted{color:var(--muted)}.faint{color:var(--faint)}.small{font-size:13px}

/* ── surfaces ───────────────────────────────────────────────────────────── */
.panel{position:relative;border-radius:28px;padding:28px;
  border:1px solid color-mix(in oklab,var(--ink) 8%,transparent);
  background:radial-gradient(80% 70% at 50% 100%,color-mix(in oklab,var(--glow) 9%,transparent),transparent 70%),
    linear-gradient(180deg,color-mix(in oklab,var(--ink) 5%,transparent),color-mix(in oklab,var(--ink) 2%,transparent))}
.panel.flat{background:var(--surface)}
.list{border-radius:22px;border:1px solid var(--rule);background:var(--surface);overflow:hidden}
.list > *{border-top:1px solid var(--rule)}
.list > *:first-child{border-top:0}

/* ── controls ───────────────────────────────────────────────────────────── */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:44px;padding:0 20px;border-radius:9999px;
  border:1px solid transparent;font:inherit;font-size:15px;font-weight:600;letter-spacing:-.01em;cursor:pointer;white-space:nowrap;
  transition:transform .15s,background-color .15s,border-color .15s,color .15s}
.btn:active{transform:scale(.98)}
.btn:disabled{cursor:progress;opacity:.75;transform:none}
.btn[aria-busy=true]::before{content:"";width:14px;height:14px;border-radius:50%;border:2px solid currentColor;
  border-right-color:transparent;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.btn-accent{background:var(--accent);color:var(--onaccent)}
.btn-accent:hover{background:color-mix(in oklab,var(--accent) 85%,transparent)}
.btn-ink{background:var(--ink);color:var(--bg)}
.btn-ink:hover{background:color-mix(in oklab,var(--ink) 85%,transparent)}
.btn-ghost{background:transparent;border-color:var(--rule);color:var(--ink)}
.btn-ghost:hover{border-color:#ffffff2e;background:#ffffff08}
.btn-danger{background:transparent;border-color:color-mix(in oklab,var(--danger) 45%,transparent);color:var(--danger)}
.btn-danger:hover{background:color-mix(in oklab,var(--danger) 10%,transparent)}
.btn-sm{height:36px;padding:0 14px;font-size:14px}
.btn-wide{width:100%;height:52px;font-size:16px}
.textlink{color:var(--muted);text-decoration:underline;text-decoration-color:#ffffff30;text-underline-offset:3px;transition:color .15s}
.textlink:hover{color:var(--ink)}

.chip{display:inline-flex;align-items:center;gap:7px;height:26px;padding:0 11px;border-radius:9999px;border:1px solid var(--rule);
  background:color-mix(in oklab,var(--surface) 60%,transparent);color:var(--muted);font-size:12.5px;font-weight:500;white-space:nowrap}
.dot{width:7px;height:7px;border-radius:50%;background:var(--faint);flex:none}
.dot-on{background:var(--on);box-shadow:0 0 0 3px color-mix(in oklab,var(--on) 18%,transparent)}
.dot-off{background:var(--faint)}
.dot-bad{background:var(--danger);box-shadow:0 0 0 3px color-mix(in oklab,var(--danger) 18%,transparent)}
.chip-accent{border-color:color-mix(in oklab,var(--accent) 35%,transparent);color:var(--accent)}

.flash{display:flex;align-items:center;gap:10px;width:fit-content;margin:0 0 28px;padding:10px 16px 10px 14px;border-radius:9999px;
  background:var(--surface);border:1px solid var(--rule);font-size:14px}
.alert{margin:0 0 32px;padding:16px 20px;border-radius:18px;font-size:14px;
  background:color-mix(in oklab,var(--danger) 9%,var(--surface));border:1px solid color-mix(in oklab,var(--danger) 30%,transparent)}
.alert a{color:var(--ink);text-decoration:underline;text-underline-offset:3px}

/* ── accounts ───────────────────────────────────────────────────────────── */
.accounts{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(330px,100%),1fr));gap:20px}
.account{display:flex;flex-direction:column;gap:26px;transition:border-color .2s}
.account:hover{border-color:color-mix(in oklab,var(--ink) 18%,transparent)}
.who{display:flex;align-items:center;gap:14px}
.avatar{display:grid;place-items:center;width:48px;height:48px;border-radius:15px;background:var(--accent);color:var(--onaccent);
  font-weight:800;font-size:21px;letter-spacing:-.04em;flex:none}
.who b{display:block;font-size:19px;letter-spacing:-.025em}
.figures{display:flex;gap:36px}
.figure b{display:block;font-size:30px;font-weight:700;letter-spacing:-.04em;line-height:1.1;font-variant-numeric:tabular-nums}
.figure span{color:var(--muted);font-size:13px}
.empty{padding:56px 28px;text-align:center}
.empty h2{margin-bottom:8px}
.empty p{margin:0 auto 22px;max-width:44ch;color:var(--muted)}

/* ── rules list ─────────────────────────────────────────────────────────── */
.rule-row{display:grid;grid-template-columns:52px minmax(0,1.4fr) minmax(0,1fr) auto auto;align-items:center;gap:18px;
  padding:14px 20px 14px 14px;transition:background-color .15s}
.rule-row:hover{background:#ffffff06}
.rule-thumb{width:52px;height:68px;border-radius:12px;object-fit:cover;background:var(--band);border:1px solid var(--rule)}
.rule-thumb.dm{display:grid;place-items:center;height:52px;color:var(--accent);background:color-mix(in oklab,var(--ink) 8%,transparent);border:0}
.rule-thumb.dm .i{width:22px;height:22px}
.rule-name{font-weight:600;letter-spacing:-.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rule-sub{color:var(--muted);font-size:13px}
.kw{display:flex;flex-wrap:wrap;gap:6px}
.kw span{padding:2px 9px;border-radius:9999px;background:#ffffff0d;font-size:12.5px;color:var(--ink)}
.kw i{color:var(--muted);font-size:13px}
.count{text-align:right;font-variant-numeric:tabular-nums;font-weight:600}
.count small{display:block;color:var(--muted);font-weight:400;font-size:12px}

/* ── reels grid: the phone-framed hero ──────────────────────────────────── */
.reels{display:grid;grid-template-columns:repeat(auto-fill,minmax(176px,1fr));gap:22px}
.reel{display:flex;flex-direction:column;gap:10px}
.phone{position:relative;aspect-ratio:9/16;border-radius:22px;overflow:hidden;background:var(--band);
  box-shadow:0 0 0 1px #ffffff14;transition:transform .25s var(--ease),box-shadow .25s}
.reel:hover .phone{transform:translateY(-3px);box-shadow:0 18px 40px -18px #000,0 0 0 1px #ffffff30}
.reel.is-live .phone{box-shadow:0 0 0 2px var(--accent),0 18px 50px -22px color-mix(in oklab,var(--glow) 60%,transparent)}
.phone img{width:100%;height:100%;object-fit:cover}
.phone .shade{position:absolute;inset:auto 0 0;padding:44px 12px 12px;background:linear-gradient(transparent,#000000d9);display:flex;flex-direction:column;gap:7px}
.phone .chip{background:#000000a6;border-color:#ffffff1f;color:var(--ink);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.phone .tap{position:absolute;inset:0;display:grid;place-items:center;opacity:0;transition:opacity .2s;background:#00000059}
.phone .tap span{padding:9px 16px;border-radius:9999px;background:var(--accent);color:var(--onaccent);font-weight:600;font-size:14px}
.reel:hover .tap,.reel:focus-visible .tap{opacity:1}
.stats-row{display:flex;gap:12px;font-size:12.5px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--ink)}
.stats-row span{display:inline-flex;align-items:center;gap:4px}
.stats-row .i{width:14px;height:14px}
.stats-row .na{color:var(--faint);font-weight:500}
.reel .cap{font-size:13px;line-height:1.45;color:var(--muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.reel .date{font-size:12px;color:var(--faint)}
.pager{display:flex;gap:10px;margin-top:28px}

/* ── activity ───────────────────────────────────────────────────────────── */
.event{display:grid;grid-template-columns:36px minmax(0,1fr) auto;gap:14px;align-items:start;padding:14px 20px 14px 16px}
.event-icon{display:grid;place-items:center;width:36px;height:36px;border-radius:11px;background:color-mix(in oklab,var(--ink) 8%,transparent);color:var(--accent)}
.event-icon.bad{color:var(--danger);background:color-mix(in oklab,var(--danger) 12%,transparent)}
.event-line{font-size:14.5px}
.event-line b{font-weight:600}
.event-text{margin-top:3px;color:var(--muted);font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.event-err{margin-top:4px;color:var(--danger);font-size:13px}
.event time{color:var(--faint);font-size:12.5px;white-space:nowrap;padding-top:2px}

/* ── rule editor ────────────────────────────────────────────────────────── */
.editor{display:grid;grid-template-columns:300px minmax(0,1fr);gap:36px;align-items:start}
.aside{position:sticky;top:96px;display:flex;flex-direction:column;gap:18px}
.aside .phone{border-radius:26px;box-shadow:var(--frame)}
.aside .cap{color:var(--muted);font-size:13.5px;line-height:1.5;white-space:pre-line;max-height:8.2em;overflow:hidden;
  -webkit-mask-image:linear-gradient(#000 70%,transparent);mask-image:linear-gradient(#000 70%,transparent)}
.cap-toggle summary{list-style:none;cursor:pointer;display:flex;flex-direction:column;gap:6px}
.cap-toggle summary::-webkit-details-marker{display:none}
.cap-toggle[open] .cap{max-height:none;-webkit-mask-image:none;mask-image:none}
.cap-toggle .more{width:fit-content;font-size:13px;font-weight:600;color:var(--ink);
  text-decoration:underline;text-decoration-color:#ffffff30;text-underline-offset:3px}
.cap-toggle .more::before{content:"See all"}
.cap-toggle[open] .more::before{content:"Show less"}
.cap-toggle summary:hover .more{text-decoration-color:var(--ink)}
.form{display:flex;flex-direction:column;gap:20px}
.group{display:flex;flex-direction:column;gap:22px}
.group-title{display:flex;align-items:center;gap:12px;margin:0;font-size:12px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--accent)}
.group-title::after{content:"";flex:1;height:1px;background:var(--rule)}
.field{display:flex;flex-direction:column;gap:8px}
.field > span:first-child{font-size:14px;font-weight:600}
.hint{color:var(--muted);font-size:13px;line-height:1.5}
.hint code{font:inherit;color:var(--ink);background:#ffffff12;padding:1px 7px;border-radius:6px}
input[type=text],input[type=url],input[type=password],input[type=email],textarea{width:100%;font:inherit;font-size:15px;color:var(--ink);background:var(--field);
  border:1px solid var(--rule);border-radius:14px;padding:12px 15px;transition:border-color .15s,box-shadow .15s,background-color .15s}
input::placeholder,textarea::placeholder{color:var(--faint)}
input:hover,textarea:hover{background:var(--field-hover)}
input:focus,textarea:focus{outline:none;border-color:color-mix(in oklab,var(--accent) 60%,transparent);
  box-shadow:0 0 0 4px color-mix(in oklab,var(--accent) 14%,transparent)}
textarea{min-height:104px;resize:vertical;line-height:1.5}
.field.has-error input,.field.has-error textarea{border-color:color-mix(in oklab,var(--danger) 60%,transparent)}
.err{color:var(--danger);font-size:13px;font-weight:500}

.switch{display:flex;align-items:center;justify-content:space-between;gap:16px;cursor:pointer}
.switch b{display:block;font-size:14.5px;font-weight:600}
.switch input{appearance:none;-webkit-appearance:none;position:relative;flex:none;width:44px;height:26px;margin:0;border-radius:9999px;
  background:#ffffff1f;cursor:pointer;transition:background-color .2s}
.switch input::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:var(--ink);
  transition:transform .25s var(--ease)}
.switch input:checked{background:var(--accent)}
.switch input:checked::after{transform:translateX(18px);background:var(--onaccent)}
.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center;padding-top:4px}

/* what the commenter receives */
.convo{display:flex;flex-direction:column;gap:14px;padding:20px;border-radius:22px;background:var(--surface);border:1px solid var(--rule)}
.convo-label{font-size:12px;color:var(--faint)}
.bubble-row{display:flex;gap:9px;align-items:flex-end}
.bubble-av{width:26px;height:26px;border-radius:50%;background:var(--accent);color:var(--onaccent);display:grid;place-items:center;
  font-size:12px;font-weight:800;flex:none}
.bubble{max-width:100%;padding:10px 14px;border-radius:20px 20px 20px 6px;background:#262626;font-size:14px;line-height:1.45;
  white-space:pre-wrap;overflow-wrap:anywhere}
.bubble .link{color:#8cb4ff;text-decoration:underline;text-underline-offset:2px}
.bubble-btn{display:block;margin:10px -4px -2px;padding:9px 12px;border-radius:12px;background:#363636;text-align:center;font-weight:600}
.bubble-row.me{justify-content:flex-end}
.bubble.me{border-radius:20px 20px 6px 20px;background:#5b4cf0}
/* "Button first": its fields show only while switched on (no script needed) */
.gate:has(input[name=buttonFirst]:not(:checked)) .reveal,
.gate:has(input[name=followFirst]:not(:checked)) .reveal-follow{display:none}
.reveal,.reveal-follow{display:flex;flex-direction:column;gap:22px}
.comment{font-size:13.5px;line-height:1.45}
.comment b{font-weight:600}
.comment.reply{margin-left:22px;padding-left:12px;border-left:1px solid var(--rule)}

.tester{display:flex;gap:10px}
.tester input{flex:1}
.verdict{display:flex;align-items:center;gap:10px;margin-top:14px;font-size:14px}

details.danger summary{list-style:none;cursor:pointer;color:var(--muted);font-size:14px;display:inline-flex;gap:8px;align-items:center}
details.danger summary::-webkit-details-marker{display:none}
details.danger summary:hover{color:var(--ink)}
details.danger[open] summary{margin-bottom:14px}
.confirm{display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-size:14px;color:var(--muted)}

/* ── login ──────────────────────────────────────────────────────────────── */
.login{min-height:100vh;display:grid;place-items:center;padding:24px}
.login .panel{width:100%;max-width:420px;padding:40px 36px 36px}
.login .mark{width:44px;height:44px;margin-bottom:26px}
.login h1{font-size:34px;margin-bottom:8px}
.connected{list-style:none;padding:0;margin:0 0 26px;display:flex;flex-direction:column;gap:12px}
.connected li{display:flex;gap:12px;align-items:baseline}
.connected .dot{transform:translateY(-1px)}
.connect-body p{margin:0 0 22px}
.marker{background-image:linear-gradient(to top,transparent .06em,color-mix(in oklab,var(--accent) 60%,transparent) .06em,
  color-mix(in oklab,var(--accent) 60%,transparent) .44em,transparent .44em);-webkit-box-decoration-break:clone;box-decoration-break:clone;padding-inline:.06em}

@media (max-width:860px){
  .editor{grid-template-columns:minmax(0,1fr)}
  .aside{position:static;display:grid;grid-template-columns:140px minmax(0,1fr);align-items:start}
  .rule-row{grid-template-columns:44px minmax(0,1fr) auto;gap:14px}
  .rule-row .kw,.rule-row .count{display:none}
  .rule-thumb{width:44px;height:58px}
}
@media (max-width:560px){
  .wrap{padding:92px 16px 72px}
  .brand span{display:none}
  .reels{grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
  .aside{grid-template-columns:104px minmax(0,1fr);gap:14px}
  .aside .phone{border-radius:16px}
  .aside .shade{display:none}
  .tester{flex-direction:column}
  .panel{padding:22px;border-radius:24px}
  .figures{gap:24px}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;
