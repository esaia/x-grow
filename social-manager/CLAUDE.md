# CLAUDE.md: social-manager

Social media management on Cloudflare Workers (free tier). Today it does one
thing: comment-to-DM auto-replies for any number of connected Instagram
accounts and Facebook Pages, managed from an admin panel at `/admin`. Scheduled posts
and cross-posting are planned. It is independent of `../extension`: its own
package.json, its own Node version (22; current wrangler refuses Node 20), no
shared code. Setup, behaviour and log events are in `README.md`.

Deployed at https://social-manager.esaiagafrindashvili.workers.dev (Meta
app id 1164880839593896, D1 `social-manager`). For now it connects only the
owner's own accounts (Standard Access); it may become a service later.

## Commands

```bash
nvm use                       # Node 22 from .nvmrc
npm run db:migrate:local      # local D1 schema
npm run webhook -- seed-account           # fake account + example rule in local D1
npm run dev                   # wrangler dev; .dev.vars has DRY_RUN=true; /admin password local-admin-key
npm run webhook -- comment "chrisstmas"   # signed fake Instagram webhook → local Worker
npm test                      # vitest
npm run compile               # tsc --noEmit
npm run deploy                # applies pending D1 migrations, then deploys
```

## Layout: one engine, one adapter per network

`src/autoreply/` is the engine and the admin panel: matching, dedup,
handling, past comments, pages and D1 queries. It is written against the
`Client` contract in `src/networks.ts`. Each network (`src/instagram/`,
`src/facebook/`) is only a `client.ts` (Graph calls, normalised to
Post/NetComment) and a `webhook.ts` (payload → `handleComment` /
`handleDm`). A new network is one entry in `NETWORKS` plus those two files,
never another panel. Tables are shared, with a `network` column (migration
0002). Log events are `<network>.…`.

## Instagram: Unified Login, not Instagram Login

The Meta dashboard no longer offers "API setup with Instagram login" to new
apps, only **Unified login**:
- **Host:** `graph.facebook.com`.
- **Tokens:** system-user tokens (configuration "Expiration: Never"), so there is no refresh job.
- **Account IDs:** `/me` is the system user, not an Instagram account. Use `/me/assigned_instagram_accounts`; its `id` equals the webhook `entry[].id`.
- **Webhooks:** each account has to be subscribed with `POST /{ig-id}/subscribed_apps`. The connect callback does this.
- **Comment id:** Unified payloads carry it as `value.comment_id`; the handler also accepts `id`.
- **Permissions:** `instagram_basic` / `instagram_manage_comments` / `instagram_manage_messages`.

Don't "fix" any of this back to graph.instagram.com.

## Things that must not be "cleaned up"

- **Signature is checked before JSON.parse, on the raw bytes, then on Meta's escaped-unicode form** (Meta signs `\uXXXX`-escaped payloads). Re-serialising a parsed body changes the bytes.
- **200 first, work in `ctx.waitUntil`.** A slow response makes Meta redeliver, and redelivery is a second DM attempt.
- **Dedup is an atomic claim (`claimSent`, an upsert on the primary key) made *before* sending**, released only when the send fails. Don't turn it into read-then-write.
- **The public "Sent!" reply only happens after the private reply succeeded.**
- **Every rule query is scoped by `network` + `account_id`.** A DM to one account must never be answered with another account's link. `anyComment` never applies to DMs.
- **`/connect/instagram` has no admin gate on purpose.** Meta's Standard Access already limits login to people with a role on the app. The `state` cookie check is the CSRF guard; keep it.
- **Admin panel security:**
  - Its only script is `public/admin.js` (busy states on submit), allowed by `script-src 'self'`. No inline scripts or handlers, and every form must keep working without the script.
  - Every interpolation goes through the `html` tag. Use `raw()` only for strings built in code, never for data from Instagram or forms.
  - POSTs need the SameSite=Strict session cookie plus a same-origin `Origin`.
- **Every panel route goes through `currentViewer`.** Members only reach accounts in `user_accounts` (`viewer.can`). Anything else must 404, not 403, so a member can't probe which accounts exist. Connect, disconnect, People and `/admin/api` are owner-only.
- **Sessions are signed over the user's password salt.** That is what makes a password change or removal end sessions; keep it in the signature.
- **Tokens are never logged, rendered or returned.** They travel in the `Authorization` header, and every call carries `appsecret_proof`.

## Admin panel design

The panel uses llamapresenter.com's dark site theme, taken from its CSS: `site-*` colour tokens, Geist (self-hosted in `public/fonts`, OFL), the floating blurred pill nav, 28px glow panels, and yellow `#fcdf50` pill buttons with `#191818` text. Tokens and components live in `src/admin/html.ts`. Restyle there; don't introduce a second palette. Reels render as phone frames (the page's focal point), and the rule editor shows a preview of the comment reply and DM.

Views come from `/{media-id}/insights?metric=views`, which needs `instagram_manage_insights` in the login configuration. Without it the panel shows "–" and a hint, while likes and comment counts (media fields) always work.

## Facebook Pages

- **Login:** a separate Facebook Login for Business configuration (Page assets, `FB_LOGIN_CONFIG_ID`). `/me/accounts` turns the system-user token into Page tokens, with `/me/assigned_pages` as a fallback.
- **Webhooks:** object `page`. `feed` carries comments (`item=comment`, `verb=add`) and `messages` carries Messenger.
- **Replies:** the private reply is `POST /{page-id}/messages {recipient:{comment_id}}`; the public reply is `POST /{comment-id}/comments`.
- **Commenter id:** some comments arrive without `from`; dedup then keys on `comment:<id>`.
- **Unverified live:** whether Page permissions work under Standard Access for the app owner once the app is Live. Meta's docs are ambiguous.

## Meta API facts, verified 2026-11-24 (Graph API v27.0)

Private reply = `POST /{ig-id}/messages` with `recipient.comment_id`. Public reply = `POST /{comment-id}/replies`.
Code exchange = `GET /oauth/access_token` with the **Meta** app id/secret.
Docs conflict on whether `comments` webhooks need Advanced Access, and don't name the webhook-signing secret for Unified. `IG_APP_SECRET_ALT` exists for the latter.
