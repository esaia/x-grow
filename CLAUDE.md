# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

X-Grow is an AI copilot for growing an X (Twitter) account. Two parts share one Anthropic (Claude) API key:

- **`platform/`** — Laravel 12 + Inertia + React (MySQL) app. It's both the API the extension calls *and* the dashboard (voice profile, weekly schedule, history, connect).
- **`extension/`** — a Chrome extension (WXT + React + TypeScript) that injects **✨ AI** buttons into x.com to generate replies/posts in the user's voice and inserts them into X's own composer.

The Anthropic key lives **only** in `platform/.env`, never in the extension. The extension authenticates to the platform's `/api` with a Sanctum personal access token generated on the dashboard's `/connect` page. The AI is assist-only — it drafts, the user clicks Post; nothing auto-posts (don't add silent auto-posting, it risks account suspension).

```
Chrome extension  ──HTTPS──▶  Laravel platform (MySQL)  ──HTTPS──▶  Claude API
  reads x.com                   /api  +  dashboard                  (server-side
  ✨ buttons     ◀──JSON──       voice profile, tokens    ◀──JSON──   key only)
  inserts text                   usage, history
```

## Commands

### Platform (`cd platform`)

```bash
composer dev              # runs serve + queue + vite concurrently (Laravel 12's `php artisan dev`)
php artisan serve         # backend only, http://localhost:8000
npm run dev                # Vite dev server only (needed alongside `serve` if not using `composer dev`)

composer test              # config:clear + lint:check + types:check + php artisan test — run before considering PHP work done
php artisan test           # PHPUnit only
php artisan test --filter=TestName   # single test

composer lint               # Pint, auto-fix
composer lint:check         # Pint, check only (CI)
composer types:check        # phpstan (larastan) analyse, level 7

npm run lint                # eslint --fix
npm run lint:check          # eslint (CI)
npm run format               # prettier --write resources/
npm run format:check
npm run types:check          # tsc --noEmit

php artisan wayfinder:generate   # regenerate resources/js/routes + resources/js/actions after changing PHP routes/controllers
php artisan migrate
```

CI (`.github/workflows/`) runs `lint.yml` (Pint + eslint + prettier + types) and `tests.yml` (PHPUnit on PHP 8.3–8.5) on push/PR to `develop`/`main`/`master`/`workos`.

Test login (seeded): `test@example.com` / `password`.

### Extension (`cd extension`)

```bash
npm run dev          # wxt dev — builds to .output/chrome-mv3 and watches
npm run build         # production build
npm run compile       # tsc --noEmit
```

Load unpacked in Chrome: `chrome://extensions` → enable Developer mode → **Load unpacked** → `extension/.output/chrome-mv3`.

No test suite in the extension.

## Architecture

### Platform (Laravel + Inertia + React, "new-york" shadcn/ui, Tailwind v4)

- **`app/Services/ClaudeService.php`** — thin wrapper around the Anthropic Messages API (`config('services.anthropic.*')`, env `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL`/`ANTHROPIC_BASE_URL`). Has `message()` (single call) and `generateOptions()` (asks Claude for `{"options": [...]}` JSON, with fallback parsing if the model doesn't comply).
- **`app/Services/PromptBuilder.php`** — the single source of truth for prompt construction. `systemPrompt()` builds the persona + voice from a `VoiceProfile`; `postPrompt()`/`replyPrompt()` build per-request instructions; `weeklyBatchPrompt(array $categories)` builds a numbered, per-slot-styled prompt for batch weekly generation (reused for both full-week generation and single-post regeneration by passing a one-element category array). `TONES`, `POST_FORMATS`, and `POST_CATEGORIES` are the canonical enums — shared with the frontend by hand (e.g. `voice.tsx`'s `TONE_META`, `schedule.tsx`'s `CATEGORY_COLORS` must be kept in sync manually when these change).
- **API routes (`routes/api.php`)** — `auth:sanctum`, consumed only by the Chrome extension: `/me`, `/voice-profile`, `/voice/learn`, `/generate/{reply,post}`, `/generate/recent`. Controllers in `app/Http/Controllers/Api/`.
- **Web routes (`routes/web.php`)** — `auth,verified`, the Inertia dashboard: `/dashboard`, `/voice`, `/history`, `/schedule` (+ `schedule/generate`, `schedule/posts/{post}` update/regenerate/destroy), `/connect` (Sanctum token management). Controllers in `app/Http/Controllers/`.
- **Models**: `User`, `VoiceProfile` (the writing-style profile the AI mimics), `Generation` (flat audit log of every AI call — reply/post, `output` is a JSON array of option strings, `meta` carries request context like tone/format or `weekly_schedule`/`regenerate` flags), `ScheduledPost` (a single weekly-schedule draft: `content`, `category`, `scheduled_at`, optional `generation_id` back-reference).
- **Weekly Schedule feature**: `ScheduleController::generate()` cycles the selected `POST_CATEGORIES` across `per_day * 7` slots, makes **one** Claude call for the whole batch (not one per slot — avoids stacking ~20 sequential HTTP round trips; there is no queue infra in this app, generation is synchronous everywhere), then deletes/replaces that week's existing drafts in a DB transaction. `update()` rejects saving a post to a time slot another post already occupies that day (returns a validation error, doesn't silently collide). `regenerate()` reuses `weeklyBatchPrompt([$category])` for a single post.
- **Wayfinder** (`@laravel/vite-plugin-wayfinder`) auto-generates `resources/js/routes/**` and `resources/js/actions/**` TypeScript helpers from PHP routes/controllers — regenerate with `php artisan wayfinder:generate` after adding/changing routes; don't hand-edit those generated files.
- **Frontend pages** (`resources/js/pages/*.tsx`) follow a consistent pattern: `Heading` + shadcn `Card`s inside `<div className="flex h-full flex-1 flex-col gap-6 p-4">`, Inertia `useForm` for forms, `router.get/post/put/delete` for one-off actions, a `Page.layout = { breadcrumbs: [...] }` static property for the sidebar breadcrumb. Sidebar nav items live in `resources/js/components/app-sidebar.tsx`.
- **SSR is enabled** (`build:ssr` / Inertia SSR) — client-only values (current date/time, timezone-dependent formatting, `Math.random()`) must not be computed during the initial render or React will throw a hydration mismatch; compute them in a `useEffect` and gate rendering on client-mounted state instead (see `schedule.tsx`'s `todayKey`/`nowOffset` pattern).
- Times chosen/stored for scheduled posts are **wall-clock values, not real timezone-aware instants** — the frontend reads `HH:MM` directly out of the ISO string rather than constructing a `Date` and calling `toLocaleTimeString`, since the latter re-interprets the stored UTC time in the browser's local timezone and silently shifts the displayed time.
- No queue/job infrastructure is wired up (`QUEUE_CONNECTION=database` in env but nothing dispatches jobs) — all AI generation, including the weekly batch, runs synchronously within the request.
- No credits/usage-limiting system exists yet; `Api/AccountController@me` exposes a raw generation count to the extension for display only, no enforcement.

### Extension (WXT + React + TypeScript, Manifest V3)

- **`entrypoints/background.ts`** — owns the Sanctum token; the only context that calls the platform API.
- **`entrypoints/content.ts`** — injects the ✨ AI buttons into x.com and observes the page as an SPA.
- **`entrypoints/popup/`** — connect/status UI.
- **`lib/xdom.ts`** — **the single source of truth for all x.com DOM selectors and text insertion.** X's DOM changes often and is obfuscated; when buttons stop appearing or text stops inserting into the composer, the fix is almost always here (`data-testid` selectors). Text insertion uses `document.execCommand('insertText')` to drive X's Draft.js editor, with synthetic `InputEvent` fallbacks.
- **`lib/panel.ts`** — the Shadow-DOM options panel rendered over x.com.
- **`lib/api.ts` / `messaging.ts` / `storage.ts` / `config.ts` / `types.ts`** — API client, background↔content messaging, token storage, config, shared types.
- A "thread" generation option is inserted as one block of text (tweets separated by blank lines) for the user to split manually — X has no single-call thread composer in the DOM.
- **Production deploy note**: after deploying the platform, update `APP_URL` and add the https domain to `host_permissions` in `wxt.config.ts`, then rebuild — the popup's API URL follows `APP_URL`.

## Phase 2 (SaaS)

The platform is already multi-user (registration + Sanctum built in). Turning it into a SaaS means: enforce per-plan usage limits in `GenerationController`, add `laravel/cashier` + Stripe for billing, add a marketing/landing page.
