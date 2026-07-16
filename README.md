# X-Grow

An AI copilot for growing your X (Twitter) account — like xposterai / superx /
xholic. It has two parts that share your **Anthropic (Claude) API key**:

- **`platform/`** — a Laravel + Inertia + React (MySQL) app. It's both the API
  the extension calls *and* your dashboard (voice profile, history, connect).
- **`extension/`** — a Chrome extension (WXT + React + TypeScript) that injects
  **✨ AI** buttons into x.com to generate **replies** and **posts** in your
  voice, then inserts them into X's own composer for you to review and post.

> **No paid X API needed.** The extension reads tweets straight from the page
> and writes into X's compose box. The only paid dependency is your Claude key.

The AI is **assist-only**: it drafts, *you* click Post. Nothing auto-posts.

---

## Architecture

```
Chrome extension  ──HTTPS──▶  Laravel platform (MySQL)  ──HTTPS──▶  Claude API
  reads x.com                   /api  +  dashboard                  (server-side
  ✨ buttons     ◀──JSON──       voice profile, tokens    ◀──JSON──   key only)
  inserts text                   usage, history
```

The Anthropic key lives **only** in `platform/.env`. The extension authenticates
to the API with a Sanctum token you generate on the dashboard.

---

## Prerequisites

- PHP 8.2+, Composer
- Node 18+ and npm
- MySQL running locally
- Google Chrome

---

## 1) Run the platform

```bash
cd platform

# First time only: install deps (already done in this workspace)
composer install
npm install

# Environment (already configured in this workspace)
cp .env.example .env          # if .env doesn't exist
php artisan key:generate      # if APP_KEY is empty
```

**Database.** This workspace already created a MySQL database `x_grow` and a user
`xgrow` / `xgrow_secret`. To recreate from scratch:

```sql
CREATE DATABASE x_grow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'xgrow'@'127.0.0.1' IDENTIFIED BY 'xgrow_secret';
CREATE USER 'xgrow'@'localhost' IDENTIFIED BY 'xgrow_secret';
GRANT ALL PRIVILEGES ON x_grow.* TO 'xgrow'@'127.0.0.1';
GRANT ALL PRIVILEGES ON x_grow.* TO 'xgrow'@'localhost';
FLUSH PRIVILEGES;
```

**Add your Anthropic key** to `platform/.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-5        # or claude-haiku-4-5-20251001 / claude-opus-4-8
```

Then:

```bash
php artisan migrate       # creates users, voice_profiles, generations, tokens
php artisan serve         # http://localhost:8000

# In a second terminal, for live-reloading UI during development:
npm run dev
# (or `npm run build` once to serve prebuilt assets without the dev server)
```

**Test login (already seeded):** `test@example.com` / `password`

Set your **voice profile** at `/voice` (paste a few of your best tweets — this is
what makes output sound like you), then go to `/connect`.

---

## 2) Run the extension

```bash
cd extension
npm install            # already done in this workspace
npm run dev            # builds to .output/chrome-mv3 and watches
# or a one-off production build:
npm run build
```

**Load it in Chrome:**

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. **Load unpacked** → select `extension/.output/chrome-mv3`

---

## 3) Connect the extension

1. On the dashboard, open **Connect extension** (`/connect`) → **Generate token** → copy it.
2. Click the **X-Grow** icon in Chrome's toolbar.
3. Confirm the API URL is `http://localhost:8000/api`, paste the token, click **Connect**.
   The popup should show "Connected as …" plus your usage.

---

## 4) Use it on X

1. Go to **x.com**.
2. Open a tweet's reply box, or the composer. A **✨ AI** button appears in the toolbar.
3. Click it:
   - On a reply → generates 3 replies in your voice from the tweet's text.
   - On the composer → ask for a topic, pick a format (single / hook / thread).
4. Click **Insert** on the option you like → it drops into X's box → **you** review and Post.

---

## Project layout

```
platform/
  app/Services/ClaudeService.php     # Anthropic Messages API wrapper
  app/Services/PromptBuilder.php     # system prompt from your voice profile + templates
  app/Http/Controllers/Api/          # GenerationController, VoiceProfileController, AccountController
  app/Http/Controllers/              # VoiceController, HistoryController, ConnectExtensionController (dashboard)
  app/Models/                        # VoiceProfile, Generation, User
  routes/api.php                     # Sanctum-protected: /me, /voice-profile, /generate/{reply,post}
  routes/web.php                     # dashboard: /voice, /history, /connect
  resources/js/pages/                # voice.tsx, connect.tsx, history.tsx (Inertia + React)

extension/
  wxt.config.ts                      # manifest: permissions, host_permissions, matches
  entrypoints/background.ts          # owns the token; the only context that calls the API
  entrypoints/content.ts             # injects ✨ buttons, observes x.com's SPA
  entrypoints/popup/                 # connect / status UI
  lib/xdom.ts                        # ALL x.com DOM selectors + text insertion (fix here when X changes)
  lib/panel.ts                       # the Shadow-DOM options panel
  lib/api.ts, messaging.ts, storage.ts, config.ts, types.ts
```

---

## Notes & known limits

- **X's DOM changes often** and is obfuscated. When buttons stop appearing or text
  stops inserting, the fix is almost always in `extension/lib/xdom.ts` (the
  `data-testid` selectors). It's deliberately the single source of X-DOM truth.
- **Text insertion** uses `document.execCommand('insertText')` — the reliable way
  to drive X's Draft.js editor from an extension. If a future Chrome drops it, the
  fallback synthetic `InputEvent`s in `xdom.ts` take over.
- **Threads**: a "thread" option is inserted as one block of text (tweets separated
  by blank lines) for you to split — X has no single-call thread composer in the DOM.
- **Production hosting**: Laravel needs PHP + MySQL hosting (Forge/Ploi/VPS), not a
  static/Vercel host. After deploying, set `APP_URL` to your https domain and add
  `'https://your-domain/*'` to `host_permissions` in `wxt.config.ts`, then rebuild
  the extension. The `/api` URL in the popup follows `APP_URL`.
- **Terms of Service**: this is assist-only (a human posts). Don't add silent
  auto-posting — that risks account suspension.

## Phase 2 (when you want to sell it)

The architecture is already multi-user (registration + Sanctum are built in). To
turn it into a SaaS: enforce per-plan usage limits in `GenerationController`, add
`laravel/cashier` + Stripe for billing, and add a marketing/landing page.
