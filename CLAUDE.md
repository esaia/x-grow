# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

X-Grow is an AI copilot for growing an X (Twitter) account. Two parts share one OpenAI API key:

- **`platform/`** — Laravel 12 + Inertia + React (MySQL) app. It's both the API the extension calls *and* the dashboard (voice profile, weekly schedule, history, connect).
- **`extension/`** — a Chrome extension (WXT + React + TypeScript) that injects **✨ AI** buttons into x.com to generate replies/posts in the user's voice and inserts them into X's own composer.

The OpenAI key lives **only** in `platform/.env`, never in the extension. The extension authenticates to the platform's `/api` with a Sanctum personal access token generated on the dashboard's `/connect` page. The AI is assist-only for replies and freshly generated/regenerated drafts — it drafts, the user clicks Post (or, for the extension, inserts into X's own composer). The one exception: once the user explicitly moves a Weekly Schedule post from Draft to **Scheduled**, it auto-publishes to that post's target network (X or LinkedIn) via the connected account when its time arrives (see "Auto-posting to X and LinkedIn" below) — this only ever applies to schedule posts the user has explicitly approved, never to freshly generated drafts or extension replies.

```
Chrome extension  ──HTTPS──▶  Laravel platform (MySQL)  ──HTTPS──▶  OpenAI API
  reads x.com                   /api  +  dashboard                  (server-side
  ✨ buttons     ◀──JSON──       voice profile, tokens    ◀──JSON──   key only)
  inserts text                   usage, history
```

## Commands

### Platform (`cd platform`)

```bash
composer dev              # runs serve + queue + schedule + vite concurrently (Laravel 12's `php artisan dev`) — `schedule` drives the per-minute auto-post check
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

php artisan wayfinder:generate --with-form   # regenerate resources/js/routes + resources/js/actions after changing PHP routes/controllers (the --with-form flag is required — vite.config.ts sets formVariants: true and the auth pages use the .form helpers; omitting it breaks types:check)
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

- **`app/Services/ClaudeService.php`** — thin wrapper around the OpenAI Chat Completions API (`config('services.openai.*')`, env `OPENAI_API_KEY`/`OPENAI_MODEL`/`OPENAI_BASE_URL`). Has `message()` (single call) and `generateOptions()` (asks the model for `{"options": [...]}` JSON, with fallback parsing if it doesn't comply).
- **`app/Services/PromptBuilder.php`** — the single source of truth for prompt construction. `systemPrompt()` builds the persona + voice from a `VoiceProfile`; `postPrompt()`/`replyPrompt()` build per-request instructions; `weeklyBatchPrompt(array $categories)` builds a numbered, per-slot-styled prompt for batch weekly generation (reused for both full-week generation and single-post regeneration by passing a one-element category array). `TONES`, `POST_FORMATS`, and `POST_CATEGORIES` are the canonical enums — shared with the frontend by hand (e.g. `voice.tsx`'s `TONE_META`, `schedule.tsx`'s `CATEGORY_COLORS` must be kept in sync manually when these change).
- **API routes (`routes/api.php`)** — `auth:sanctum`, consumed only by the Chrome extension: `/me`, `/voice-profile`, `/voice/learn`, `/generate/{reply,post}`, `/generate/recent`, `/inspiration/ingest`. Controllers in `app/Http/Controllers/Api/`.
- **Inspiration** (`/inspiration`) — tracked creators (`TrackedCreator`, keyed by @handle) and their best-performing posts (`InspirationPost`), scored by `App\Services\InspirationScorer` against that creator's *own* mean engagement. The platform **never reads x.com itself**: X's API meters post reads (~$0.006 each, so one 10-creator refresh cost dollars), so the Chrome extension harvests instead — `harvestTimeline()` in `extension/lib/xdom.ts` scrolls a creator's profile in the user's own logged-in session, reads text + exact engagement counts out of the rendered DOM (the action row's `aria-label` carries exact numbers; the visible button labels are abbreviated), and POSTs them to `/api/inspiration/ingest`. Ingest **upserts** — a harvest only sees whatever that page had loaded, so it must never replace what is stored — then rescores and trims the creator to `InspirationScorer::KEEP_PER_CREATOR`. Adding a creator needs no X connection at all; the extension backfills name/avatar/followers on first harvest. Three paths feed it, all through the same endpoint: the ✨ Harvest button on a profile; **passive collection**, which sends whatever is already rendered as you read a *tracked* creator's profile and deliberately never scrolls the page you're using (`GET /api/inspiration/creators` tells the content script who is tracked); and **"Harvest all creators"** in the popup, which opens one small `windows.create` popup window and drives it through every tracked creator via `tabs.sendMessage`. That window is deliberately **visible and focused** — Chrome throttles background tabs and X only loads timeline content it believes is on screen, so a hidden tab harvests roughly one screen and stops. Anything reading profile metadata must scope its queries to `SEL.primaryColumn`: the left nav holds the logged-in user's own avatar in an identically-named `UserAvatar-Container-*` element that wins a document-wide lookup.
- **Web routes (`routes/web.php`)** — `auth,verified`, the Inertia dashboard: `/dashboard`, `/voice`, `/history`, `/schedule` (+ `schedule/generate`, `schedule/posts/{post}` update/regenerate/destroy/schedule/unschedule, `schedule/schedule-all`), `/connect` (Sanctum token management + `connect/x/*` and `connect/linkedin/*` redirect/callback for the OAuth2 connections, and `connect/accounts/{account}` to disconnect any of them). Controllers in `app/Http/Controllers/`.
- **Models**: `User`, `VoiceProfile` (the writing-style profile the AI mimics), `Generation` (flat audit log of every AI call — reply/post, `output` is a JSON array of option strings, `meta` carries request context like tone/format or `weekly_schedule`/`regenerate` flags), `ScheduledPost` (a single weekly-schedule post: `content`, `category`, `status` (`draft`/`scheduled`/`posted`/`failed`, see `ScheduledPost::STATUS_*`), `platform` (`x`/`linkedin`, see `ScheduledPost::PLATFORM_*`), `error`, `scheduled_at`, `posted_at`, `external_post_id` (a tweet id or a LinkedIn post URN depending on the platform), optional `generation_id` back-reference), `SocialAccount` (one connected posting destination — `provider` (`x`/`linkedin`), `kind` (`person`/`organization`), `external_id`, `name`/`handle`, OAuth tokens stored via Laravel's `encrypted` cast since — unlike Sanctum tokens — they must be decryptable to call those APIs. A user may connect **any number** of these, including several on the same network; unique on `(user_id, provider, external_id)` so re-connecting the same account refreshes it instead of duplicating. LinkedIn company pages are rows with `kind = organization`, connected through a second LinkedIn OAuth app and so holding their own tokens exactly like member rows).
- **Weekly Schedule feature**: `ScheduleController::generate()` cycles the selected `POST_CATEGORIES` across `per_day * 7` slots, makes **one** Claude call for the whole batch (not one per slot — avoids stacking ~20 sequential HTTP round trips; there is no queue infra in this app, generation is synchronous everywhere), then deletes/replaces that week's existing drafts (`status = draft`) in a DB transaction. `update()` rejects saving a post to a time slot another post already occupies that day (returns a validation error, doesn't silently collide), and reverts a post's status from `scheduled` back to `draft` if its content/category/time is edited (re-approval required before it can auto-post again). `regenerate()` reuses `weeklyBatchPrompt([$category])` for a single post and always resets it to `draft` for the same reason. `schedule()`/`unschedule()`/`scheduleAll()` toggle a post (or a whole week's drafts) between `draft` and `scheduled` — only `scheduled` posts are eligible for auto-posting.
- **Auto-posting to X and LinkedIn**: a user connects accounts via OAuth2 from `/connect` — X with PKCE (`ConnectXController`), LinkedIn without, sending client credentials in the token request body (`ConnectLinkedInController`, scopes `openid profile w_member_social`). Each connection is stored as a `SocialAccount`. The `schedule:publish-due-posts` Artisan command (`app/Console/Commands/PublishDuePosts.php`), registered in `routes/console.php` via `Schedule::command(...)->everyMinute()`, finds `scheduled` posts whose `scheduled_at` has passed and hands each to `App\Services\SocialPublisher`, which routes on the post's `platform` to `XPostingService` or `LinkedInPostingService` (both mirror `ClaudeService`'s shape: `Http` facade, no SDK). Each publishes as the post's own `socialAccount` and refreshes that account's token first if expired — X rotates the refresh token on every use, so the new one must be persisted each time; LinkedIn only issues refresh tokens to approved apps, so an expired LinkedIn connection usually just has to be re-made by hand. A post's content is always published as a single post verbatim — weekly-schedule content (see `PromptBuilder::weeklyBatchPrompt`) is guaranteed to be one tweet under 280 characters (the same text is what goes to LinkedIn), even when a format uses blank lines internally for visual pacing (e.g. "Question / Poll"), so those blank lines must never be read as a thread-break signal. On success the post becomes `posted` (with `posted_at`/`external_post_id` set — a tweet id for X, the `x-restli-id` response header's post URN for LinkedIn); on any failure it becomes `failed` with the error stored, and does **not** auto-retry — the user must manually re-schedule/retry. Locally, `schedule:work` runs alongside `composer dev` (see `AppServiceProvider::boot()`); in production this instead requires a system cron entry running `php artisan schedule:run` every minute, which is **not** something this codebase can configure for you.
- **LinkedIn company pages**: require a **second LinkedIn app**, configured separately under `services.linkedin.pages` (`LINKEDIN_PAGES_CLIENT_ID`/`_SECRET`/`_REDIRECT_URI`); leaving the client id blank disables page support and hides the UI. The reason is a hard LinkedIn constraint, not a preference: the **Community Management API** product "requires that it be the only product on the application", so it cannot be provisioned on the app that already holds Sign In with LinkedIn + Share on LinkedIn. Requesting `w_organization_social`/`rw_organization_admin` from the member app fails *before* the consent screen — LinkedIn shows its own generic error page and never redirects back, so the callback's `?error=` handling cannot report it. `ConnectLinkedInPagesController` runs its own handshake against the pages app, lists the pages the member administers (`/rest/organizationAcls?q=roleAssignee`), and stores each as a `SocialAccount` with `kind = organization` holding that app's token. `LinkedInPostingService::refresh()` therefore picks credentials by `kind` — page tokens must be refreshed against the pages app, member tokens against the member app. Publishing differs only in the author URN (`SocialAccount::authorUrn()`).
- **Post targeting**: every `ScheduledPost` targets exactly one `social_account_id` (with `platform` kept alongside it for display/limits). The `/schedule` Add-post modal offers a multi-select "Post to" row listing every connected account, creating one independent row per selected account; the edit modal's version is single-select, and retargeting an approved post reverts it to `draft`, like a content edit. Slot conflicts (`ScheduleController::hasConflict()`) are scoped per **account**, so two different accounts may share a time while one account can't be double-booked. Week generation (`generate()`) writes for one account chosen in the generate form. Disconnecting an account nulls its posts' `social_account_id` rather than deleting the drafts (`nullOnDelete`) — `schedule()` refuses such a post and `scheduleAll()` skips it, reporting how many were skipped.
- **Wayfinder** (`@laravel/vite-plugin-wayfinder`) auto-generates `resources/js/routes/**` and `resources/js/actions/**` TypeScript helpers from PHP routes/controllers — regenerate with `php artisan wayfinder:generate --with-form` after adding/changing routes; don't hand-edit those generated files.
- **Frontend pages** (`resources/js/pages/*.tsx`) follow a consistent pattern: `Heading` + shadcn `Card`s inside `<div className="flex h-full flex-1 flex-col gap-6 p-4">`, Inertia `useForm` for forms, `router.get/post/put/delete` for one-off actions, a `Page.layout = { breadcrumbs: [...] }` static property for the sidebar breadcrumb. Sidebar nav items live in `resources/js/components/app-sidebar.tsx`.
- **SSR is enabled** (`build:ssr` / Inertia SSR) — client-only values (current date/time, timezone-dependent formatting, `Math.random()`) must not be computed during the initial render or React will throw a hydration mismatch; compute them in a `useEffect` and gate rendering on client-mounted state instead (see `schedule.tsx`'s `todayKey`/`nowOffset` pattern).
- Times chosen/stored for scheduled posts are **wall-clock values, not real timezone-aware instants** — the frontend reads `HH:MM` directly out of the ISO string rather than constructing a `Date` and calling `toLocaleTimeString`, since the latter re-interprets the stored UTC time in the browser's local timezone and silently shifts the displayed time.
- No queue/job infrastructure is wired up (`QUEUE_CONNECTION=database` in env but nothing dispatches jobs) — all AI generation, including the weekly batch, runs synchronously within the request. The one periodic task in the app is the Laravel task **scheduler** (`routes/console.php`, `Schedule::command(...)`), which is separate from the (unused) queue — it drives `schedule:publish-due-posts` every minute.
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
