# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

X-Grow is an AI copilot for growing an X (Twitter) account, shipped as **one Chrome extension** (`extension/`, WXT + React + TypeScript, Manifest V3). There is no server, no database and no user account — it used to have a Laravel + Inertia + MySQL platform alongside it, and that has been deleted; if you find a reference to `platform/`, `/api`, a Sanctum token, or the dashboard↔extension `postMessage` bridge, it is stale.

Everything runs in the browser:

```
Chrome extension ──HTTPS──▶ OpenAI API
  content script            (the user's own key)
    ✨ buttons on x.com
  popup + dashboard tab
    the whole UI, off-page
  background worker  ◀── owns the key, owns every write
  IndexedDB          ◀── voice profile, generations, schedule, creators, inspiration
```

Onboarding is two steps, enforced in that order: **connect the X account** → **add an OpenAI key**. Both happen in the dashboard, which relays detection through an open x.com tab (`account:read`) because it runs in our own document, not on the page.

Three invariants worth stating plainly, because breaking the first two is a security bug:

1. **Only the background worker touches the OpenAI key.** x.com's CSP blocks a content-script fetch to `api.openai.com` anyway, but the real reason is that a page context must never be able to read it. `settings:get` returns `hasKey: boolean`, never the key.
2. **"Connect your X account" is not OAuth, and must not become OAuth.** The extension already runs inside the user's authenticated x.com session, so `readLoggedInAccount()` (`lib/xdom.ts`) reads the signed-in handle/name/avatar off the left nav — the Profile link's href first, the avatar container's testid suffix as fallback. Connecting is a confirmation click that stores that account in `chrome.storage.local` (`accountItem`); no tokens, no client id, no developer app. It is stored explicitly rather than re-inferred per page load, because it is a decision the user made once and it has to survive them browsing while logged out.

   The connected account **gates everything** (the composer panel, the dashboard's nav and screens), is the identity shown throughout, prefills the voice profile's `x_handle` on connect, and is the identity auto-posting publishes as.

3. **The AI is assist-only.** It drafts; the user clicks Post (or Insert, into X's own composer). The one planned exception is the weekly schedule: once a user explicitly moves a post from Draft to **Scheduled**, it auto-publishes at its time — and only ever for posts they approved, never for freshly generated drafts or extension replies.

## Commands

```bash
cd extension

npm run dev          # wxt dev — builds to .output/chrome-mv3 and watches
npm run build         # production build
npm run compile       # tsc --noEmit
npm run check:bundle  # guards against a minifier name collision (runs after `build`)
```

**`minify: 'esbuild'` in `wxt.config.ts` is load-bearing.** Vite 8's default (Oxc) minifier merged modules into one scope and gave two different top-level bindings the same short name — React DOM's lane constant `var Ke=256` and our `KEY_FIELDS` array. React does `Ke <<= 1` on its lane, our array silently became a number, and the dashboard died with "Cannot read properties of undefined (reading 'filter')". The source was correct; only the build was wrong, which is why `check:bundle` reads the built output and asserts our module constants still have unique names.

Load unpacked in Chrome: `chrome://extensions` → enable Developer mode → **Load unpacked** → `extension/.output/chrome-mv3`.

There is no test suite and no linter configured. `npm run compile`, `npm run check:bundle` and manual verification on x.com are the whole check.

## Architecture

### Background worker (`entrypoints/background.ts`)

The single owner of the OpenAI key and of every IndexedDB write. One `runtime.onMessage` listener dispatches the `BgRequest` union from `lib/messaging.ts` and always replies `{ok:true,data}` / `{ok:false,error,status}`. Handlers cover settings, voice profile, generation, inspiration ingest, data export/import, harvest orchestration, scheduling and publishing.

It also drives **"Harvest all"**: a `windows.create` popup window that walks every tracked creator via `tabs.update` + `tabs.sendMessage`. That window is deliberately **visible and focused** — Chrome throttles background tabs and X only loads timeline content it believes is on screen, so a hidden tab harvests roughly one screen and stops.

### AI (`lib/ai/`)

- **`openai.ts`** — Chat Completions wrapper. `message()` and `generateOptions()` (which asks for `{"options": [...]}` JSON with a fence-stripping fallback parser), plus `stripDashes()` as belt-and-braces against em-dashes.
- **`quality.ts`** — enforces the reply rules the prompt already states, because models ignore them. A real generation returned five options that were *all* third-person observations about categories of people ("For some…", "Not every chef…", "people who…") — the loudest machine tell there is, and the thing to check first when output feels robotic. `screenReplies()` rejects per option (agreement openers, the "curious how…" family, restating the tweet, more than one question, generalising openers); `setProblems()` catches failures only visible across the whole set (nothing in first/second person, nothing under six words). A set-level failure forces a **fresh** batch rather than a top-up, since keeping the survivors preserves the sameness. Capped at one repair call.
- **`style.ts`** — turns the owner's real posts into measured constraints ("78% of their posts start lowercase", "they almost never end with a full stop", "typical post is 6 words, shortest are 2"). "Mirror this voice" is a weak instruction; percentages are not. Every line is emitted only when the signal is strong, so a few posts never produce confident nonsense.
- **`prompts.ts`** — **the single source of truth for prompts and enums.** `TONES`, `POST_FORMATS`, `POST_CATEGORIES`, `REMIX_CLOSENESS` and `HUMAN_SAMPLING` live here and are imported by every UI that displays them; they used to be hand-synced between PHP and two frontends, so do not reintroduce a copy. The wording of these prompts *is* the product — `replyCraftGuidance()`'s anti-"AI reply guy" ruleset in particular. Paraphrasing them is a regression, not a cleanup. The one deliberate departure from the ported wording is the "React, do not generalise" block, added after real output showed the third-person-observation failure the original never named.

### Storage (`lib/db/`, `lib/storage.ts`)

- **`lib/storage.ts`** — settings only (`openai_key`, `openai_model`, `openai_base_url`) via WXT's `storage.defineItem` over `chrome.storage.local`.
- **`lib/db/idb.ts`** — a dependency-free promise wrapper over IndexedDB. One rule callers must respect: inside a `run()` callback you may only await IDB request promises. Awaiting anything else (a fetch, a `chrome.*` call, a timer) hands control back to the event loop and IndexedDB auto-commits the transaction out from under you.
- **`lib/db/index.ts`** — typed repositories: voice profile (one record at key 1), generations, scheduled posts, creators, inspiration posts, plus `exportAll()`/`importAll()`. With no server there is no other backup, which is why export shipped in the first release rather than "later".
- `"unlimitedStorage"` is in the manifest because the inspiration board keeps up to `KEEP_PER_CREATOR` (150) posts per creator, over `chrome.storage.local`'s 10MB cap.

### Time (`lib/time.ts`)

Scheduled posts store a **naive wall-clock** timestamp (`"2026-08-12T09:00"`) next to the IANA timezone it was picked in, so 9:00 AM stays 9:00 AM. Never `new Date(scheduled_at)` for display — that reinterprets it in the browser's zone and silently shifts the time. Read `HH:MM` straight out of the string (`timeOf`), and use `realInstant()` when you need the actual moment.

### The dashboard (`lib/dashboard/`)

React 19 + Tailwind v4, rendered from **one** codebase into **two** of our own documents:

- `entrypoints/popup/` — the toolbar popup. Chrome caps it at **800x600** and sizes it to its content, so `data-surface="popup"` is set in the markup (not from script, which makes the popup visibly resize) and the stylesheet fills that box.
- `entrypoints/dashboard/` — the same app in a full tab, opened by the popup's ↗ button, which carries the current screen across in the URL hash.

Neither surface is on x.com, so **the dashboard cannot read the page**. Account detection goes through `bg.detectAccount()`, which the background relays to an open x.com tab via `account:read`. There is deliberately no dashboard UI injected into x.com any more — the ✨ buttons and the reply panel are the in-context tools, and they are not modals over the page.

The dashboard owns its own dark palette and does **not** read `xtheme.ts`. That is the opposite of the rule for the on-page controls below, and the split is intentional: our own documents should look like our product, injected controls should look like X's.

Navigation is conditional rendering off a `useState`, no router. Screens land as their phase ships; unbuilt ones are left out rather than rendered as dead buttons.

### On-page UI (`lib/xdom.ts`, `lib/xtheme.ts`, `lib/xstyles.ts`, `lib/panel.ts`, `entrypoints/content.ts`)

All vanilla DOM — React lives only in the popup and the dashboard tab.

- **`lib/xdom.ts`** — **the single source of truth for all x.com DOM selectors and text insertion.** X's DOM changes often and is obfuscated; when buttons stop appearing or text stops inserting into the composer, the fix is almost always here (`data-testid` selectors). Text insertion drives X's Draft.js editor with a synthetic paste, with `beforeinput`/`input` events as fallback. Anything reading profile metadata must scope its queries to `SEL.primaryColumn`: the left nav holds the logged-in user's own avatar in an identically-named `UserAvatar-Container-*` element that wins a document-wide lookup. `harvestTimeline()` collects into a Map *as it scrolls*, because X virtualizes the timeline.
- **`lib/xtheme.ts` / `lib/xstyles.ts`** — **everything injected into x.com itself must look like X shipped it.** X is not one skin: three background themes (Default / Dim / Lights out) and six accent colours, so the tokens are *measured off the live page* rather than hard-coded. Note the two separate colour tokens: **accent** (links, icons, selected states) comes from a tweet-body link; **primary** (Post-weight buttons) comes from the sidebar Post button, which X currently fills *white on dark / black on light* — using one for the other is what makes a surface look off-brand. The font is the deliberate exception: `FONT_STACK` is written out rather than measured, because a computed value that fails to resolve makes `font-family` invalid at computed-value time, and inside an `all: initial` shadow root the initial font is a **serif** — which is exactly how the panel once shipped rendering in Times. Use X's real numbers: 15px body / 13px secondary, 9999px buttons at 32/36px tall, 34.75px round icon buttons with a 10%-accent hover wash, 16px dialog radius, hairline `--xg-line` dividers. `xstyles.ts` ships these as a **constructed stylesheet** (`adoptedStyleSheets`) — X's CSP would block a `<style>` tag, while CSSOM objects pass and still give real `:hover`/`:focus-visible`.
- **`lib/panel.ts`** — the Shadow-DOM modal over x.com, carrying its own copy of the `--xg-*` tokens. `openShell()` builds the chrome (overlay, header, Escape/⌘↵, dismissal) and both entry points render into it: `openPanel()` for the composer's ✨ button and `openRemixPanel()` for the remix button on any tweet. This is the only surface that still renders UI on x.com, and it stays React-free on purpose — the content script is ~46kB precisely because React and Tailwind are not in it.
- **Remix on the timeline** — a button in every tweet's action row (`readTweetFor()` reads author and id off the timestamp permalink, not the header, so a repost attributes correctly). It uses `remixSvg`, deliberately *not* the ✨ spark: the spark means "generate for me" and already lives in the composer. Injection is scoped to `SEL.tweetArticle SEL.tweetActions` — `[role="group"][aria-label]` alone matches other groups — and presence-checked rather than flagged, because X recycles those rows as you scroll.
- The composer's ✨ button is **icon-only** and mounts immediately left of the Reply/Post button (`submitAnchor()` climbs out of the button's single-child wrappers). Because X re-renders that row whenever Reply enables/disables, `scan()` checks for the button's **presence** (`[data-xgrow-ai]`) instead of flagging the toolbar as done — a flag would let a re-render remove the button permanently.
- A "thread" generation option is inserted as one block of text (tweets separated by blank lines) for the user to split manually — X has no single-call thread composer in the DOM.

### Inspiration (`lib/scoring.ts`, `ingestInspiration()`)

Tracked creators and their best-performing posts, scored against that creator's *own* mean engagement (`engagement()` = like + reply + retweet + quote; views are deliberately excluded because X only reports them reliably on your own posts).

Ingest **upserts by default**, and that default is load-bearing: a harvest only ever sees whatever the page had loaded, so replacing on every run would shrink the board to one screenful. The one opt-out is `replace: true`, sent only by an explicit "Update data" refresh, and applied inside the transaction — never as an upfront wipe — so a run that dies halfway can't leave the board empty.

Three paths feed it, all through the same function: the ✨ Harvest button on a profile; **passive collection**, which sends whatever is already rendered as you read a *tracked* creator's profile and deliberately never scrolls the page you're using; and **"Harvest all creators"**.

### Schedule and auto-posting (`lib/scheduler.ts`, `lib/publisher.ts`)

`scheduler.ts` generates a week with **one** OpenAI call for the whole batch, never one per slot — a 3-a-day week is 21 posts, and 21 sequential round trips inside one click is a minute of spinner. `randomTimesInRange` keeps a 60-minute minimum gap, shrinking it by 15 only when the chosen window can't fit, and jitters within the slack so times don't read as a fixed grid.

Two status rules are load-bearing and ported verbatim: editing an approved post's **content or category** drops it back to `draft` (the user approved specific text for automatic publishing); moving it in **time** does not. `regeneratePost` always resets to draft for the same reason.

`publisher.ts` replaces the old cron + OAuth + X API stack. A `chrome.alarms` tick every minute, plus `onStartup`/`onInstalled`, finds posts whose `realInstant()` has passed and publishes them **sequentially** through X's own composer in a visible scratch window (`publishInComposer()` in `xdom.ts`). Things that must not be "cleaned up":

- **The tick asks "is it due?", never "is it due right now?"** That is what makes a post whose slot passed while Chrome was closed go out late rather than never.
- **`askTab` retries transport failures only.** A well-formed `{ok:false}` is returned immediately. Retrying an application-level failure could re-send a post that published but failed its confirmation check.
- **`PUBLISH_TIMEOUT_MS` is longer than every timeout inside the publish path**, so the inner code always reports first. If the backstop fired first, a post could be marked `failed` while actually going out, and the user would repost it by hand.
- **Failures never auto-retry.** `failed` + the reason is stored; the user fixes and re-approves.
- **`publishInComposer` hard-fails on an account mismatch.** X may be signed in as someone else by the time the alarm fires; posting an approved draft from the wrong account is worse than not posting it.
- **The scratch window is visible and focused.** Same constraint as harvesting.

### Inspiration UI (`lib/dashboard/screens/Inspiration.tsx`, `RemixModal.tsx`)

Creator chips (add / filter / delete), the ranked feed, the date + baseline filters, and the remix flow. Constants ported from the platform's `inspiration.tsx`: `DATE_RANGES`, `THRESHOLDS`, `baselineColor()`'s tiers (≥3x / ≥2x / ≥1.5x), `buildTodaySlots()` and the relative-time formatter.

Two differences from the platform version, both consequences of having no server:

- **Filtering is client-side.** The platform sent only the top 300 posts and filtered by date in SQL using a timezone the frontend passed along. Everything is local now, so `dateFloor()` uses the browser's own day boundaries and the whole set is filtered in memory.
- **"Update data" calls `bg.harvestAll(true)` directly.** The old `postMessage` bridge existed only because a web page can't talk to an extension; the dashboard is the extension now.

Remix's "Post now" creates the `ScheduledPost` row *first* and then publishes, so a failure leaves something visible and retryable on the calendar. The platform deleted the row on failure; that is deliberately not copied — silent disappearance is worse than a visible `failed`.

## Roadmap

Phases 1–3 are built. Still to come:

- **History** — a UI over the `generations` store, which already records every call including remix provenance (`meta.source_tweet_id` / `source_username`).

Deliberately out of scope: the mockup's Trends / Search / Favorites nav icons have no equivalent in the product yet.
