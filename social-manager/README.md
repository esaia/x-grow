# social-manager

Social media management on Cloudflare Workers' free tier. No framework, no
runtime dependencies. One Worker, one folder per network under `src/`.

**Today:** comment-to-DM auto-replies (like ManyChat) for any number of
**Instagram accounts and Facebook Pages**, managed from an admin panel at `/admin`.
**Planned:** scheduled posts and cross-posting to several networks at once.

## Instagram auto-replies

Someone comments **"christmas"** (or "Chrisstmas!! 🎄") on one of your Reels, and the Worker:

1. sends them a **private reply** (a DM linked to their comment) with your link;
2. replies publicly under the comment: *"Sent! 🎄 Check your message requests 📩"*.

Someone DMs one of your accounts a keyword, and the Worker replies with that account's matching link.

**Button first** (Instagram, optional per auto-reply): the comment's DM is a
short message with a **"Send me the link"** button, and the link comes when
they tap it. Tapping opens the conversation, so the link lands in their inbox
rather than message requests. With **"Only send the link to followers"** on,
the tap also asks Instagram whether they follow you (`is_user_follow_business`);
if not, they get a "follow me first" message with an **"I'm following"** button,
and tapping it checks again. If Instagram can't say, they get the link: a
broken check never traps anyone. A keyword DM to a followers-only auto-reply
gets the same check.

```
you ──/admin──▶ "Connect account" ──▶ Meta login ──▶ /connect/instagram/callback
                                                     token saved per account (D1),
                                                     webhooks switched on for it
you ──/admin──▶ pick a Reel ──▶ keywords, link, DM text, public replies (D1, live instantly)

Instagram ──webhook──▶ /webhooks/instagram ──200 immediately──▶ Meta
                          │ ctx.waitUntil
                          ├─ entry.id → which account → its token
                          ├─ match keyword  (that account's rules)
                          ├─ atomic dedup   (one DM per person per Reel, 30 days)
                          ├─ graph.facebook.com ──▶ private reply + public reply / DM reply
                          └─ activity log   (shown in the panel)
```

It uses Meta's **Instagram API with Unified Login**, which is what the Meta
dashboard offers new apps today: `graph.facebook.com` with system-user
tokens. Those tokens **never expire**, so there is no refresh job.

## Layout

```
src/
  index.ts             routes: /admin, /connect/<network>, /webhooks/<network> + daily cron
  networks.ts          the Client contract + NETWORKS registry (instagram, facebook)
  meta.ts              Graph API calls, errors, code exchange (shared by both Meta networks)
  webhooks.ts          verify handshake, signature check, 200-first (shared)
  signature.ts         X-Hub-Signature-256, incl. Meta's escaped-unicode quirk
  connect.ts           "connect an account" login flow (shared)
  admin/               panel shell: login/session, templates + CSS
  autoreply/           the engine, network-agnostic:
    db.ts              every D1 query (accounts, rules, dedup, activity)
    handle.ts          comment / DM handling (match → dedup → DM → public reply → log)
    panel.ts           admin pages, backfill.ts past comments, api.ts JSON
    rules.ts, match.ts rule validation, typo-tolerant matching
  instagram/           client.ts (Graph calls) + webhook.ts (payload → engine)
  facebook/            client.ts (Page + Messenger calls) + webhook.ts
migrations/            D1 schema (0002 generalised the Instagram tables)
```

Adding a network: a `client.ts` implementing `Client`, a `webhook.ts`
that normalises its payload, and one entry in `NETWORKS`.

A new network (say Threads) gets its own `src/<network>/`, its own
`/connect`, `/webhooks` and `/admin` branches in `index.ts`, and
`<network>_`-prefixed tables and `<network>.`-prefixed log events.

---

## Setup

You need a Cloudflare account (free), a Meta developer account, a **business
portfolio**, Instagram **Business or Creator** accounts that are **public**
(Meta sends no comment webhooks for private accounts), and Node 22.12 or newer.

### 1. Cloudflare

```bash
cd social-manager
nvm use              # .nvmrc pins Node 22: current wrangler needs 22.12 or newer
npm install
npx wrangler login
npx wrangler d1 create social-manager   # paste the database_id into wrangler.toml
```

### 2. Meta app

1. Go to <https://developers.facebook.com/apps> and click **Create app**. Choose the use case **"Manage messaging & content on Instagram"**.
2. Open **Use cases → Customize → API setup with Unified login** and connect a **business portfolio** when it asks.
3. Under **1. Configure your app**, click **Create new configuration**. Keep the defaults: **System-user access token**, **Expiration: Never**, and these permissions: `instagram_basic`, `instagram_manage_comments`, `instagram_manage_messages`, `instagram_manage_insights` (views in the panel), plus `instagram_content_publish` for the scheduler later. Untick `ads_management` and `ads_read` if it allows.
4. Under **Redirect URL**, register `https://<worker>/connect/instagram/callback` and click **Save**.
5. Put the **App ID** and the **configuration ID** into `wrangler.toml` `[vars]`. Neither is secret.
6. Skip **2. Generate access tokens**: accounts are connected through the Worker (step 5 below).

On each Instagram account's phone app, go to **Settings → Messages and story
replies → Message controls → Connected tools** and turn on **Allow access to
messages**. Without it, every send fails.

### 3. Secrets

```bash
npx wrangler secret put META_APP_SECRET   # App settings → Basic → App secret
npx wrangler secret put IG_VERIFY_TOKEN   # any random string, e.g. `openssl rand -hex 24`
npx wrangler secret put ADMIN_KEY         # the admin panel password (long and random)
```

> **Which secret signs the webhooks?** Meta's docs only say "your app's App
> Secret". For Unified Login that should be the Meta app secret above. If
> `npm run tail` shows `instagram.signature.invalid` for real webhooks, and
> the dashboard shows a separate "Instagram app secret", set that one as
> `IG_APP_SECRET_ALT`. The log line `instagram.signature.ok` then names
> whichever matched.

### 4. Deploy and set up the webhook

```bash
npm run deploy    # applies D1 migrations, then deploys → https://social-manager.<sub>.workers.dev
```

Then, under **3. Configure webhooks** on the Unified login page:

1. **Callback URL:** `https://<worker>/webhooks/instagram`
2. **Verify token:** your `IG_VERIFY_TOKEN`.
3. Click **Verify and save**. `npm run tail` shows `instagram.webhook.verified`.
4. Subscribe to the **`comments`**, **`messages`** and **`messaging_postbacks`** fields.
   `messaging_postbacks` carries button taps ("Button first"). Accounts connected
   before it was added need one **Reconnect** in the panel, so their subscription
   includes it.

### 5. Log in and connect your Instagram accounts

Open **`https://<worker>/admin`** and log in with your `ADMIN_KEY` (email left empty). Then add yourself under **People** as an owner, so you can log in with your email from then on. Under
**Instagram**, click **+ Connect account**, log in with Meta, and tick the
Instagram account(s) to share. Repeat for accounts in other portfolios.
Reconnecting an account replaces its token and keeps its auto-replies.

**Who can connect?** With Standard Access (the default), only people with a
role on the Meta app can finish this login. Meta enforces that, not the
Worker. See [Opening it up to other people](#opening-it-up-to-other-people).


### Facebook Pages

Same engine, same panel (**Facebook** in the top nav). Comments arrive on the
Page's `feed` webhook; the DM goes out through **Messenger**. Rules match
Instagram's: one private reply per comment, within 7 days.

1. **Login configuration** (separate from Instagram's): App dashboard →
   **Facebook Login for Business → Configurations → Create configuration**.
   - Token: **System-user access token**, expiration **Never**.
   - Assets: **Pages**.
   - Permissions: `pages_show_list`, `pages_read_engagement`, `pages_read_user_content`, `pages_manage_engagement`, `pages_manage_metadata`, `pages_messaging`.
2. Add `https://<worker>/connect/facebook/callback` as a redirect URL (FLfB → Settings → Valid OAuth Redirect URIs).
3. Put the configuration ID in `wrangler.toml` as `FB_LOGIN_CONFIG_ID` and run `npm run deploy`.
4. **Webhooks** (App dashboard → Webhooks → object **Page**):
   - Callback URL: `https://<worker>/webhooks/facebook`, with the same verify token.
   - Subscribe to **feed** and **messages**.
5. In the panel: **Facebook → Connect Page**. The connect step subscribes each Page to the webhook.

Meta says Page permissions need App Review once an app is Live, except for
people with a role on the app. That covers your own Pages; other people's
Pages need App Review.

### 6. Test it for real

```bash
npm run tail
```

Set up an auto-reply on a Reel (next section). Then, from a **different**
Instagram account, comment the keyword. You should see
`instagram.comment.dm_sent` and `instagram.comment.public_reply_sent` in the
logs, and the same in the panel under **Recent activity**.

> **Access level: Meta's docs disagree.** One page says *"Advanced Access is
> required for comments and live_comments notifications"*. Others say
> Standard Access works for accounts you own or manage. If DMs trigger the
> Worker but comments never show up in `npm run tail`, that's the Advanced
> Access requirement, and `instagram_manage_comments` needs App Review.

---

## People and logins

- **Logging in:** everyone logs in with **email + password**. The `ADMIN_KEY` secret also logs in as an owner: leave the email empty. It's the way back in if every password is lost, and the Bearer key for `/admin/api`.
- **People** (owners only): add a person with a first password, choose **Owner** or **Member**, and tick the accounts a member may see.
  - Members see and edit only those accounts' auto-replies and past comments. They can't connect or disconnect accounts, manage people, or use the API.
  - Owners see everything.
- **My account:** anyone can change their own password. Changing it, or an owner resetting it, signs that person out everywhere. Removing someone ends their sessions immediately.
- **Security:**
  - Passwords are PBKDF2-SHA256 (60,000 rounds, per-user salt), minimum 8 characters. The round count is kept within the free plan's CPU limit.
  - 10 wrong passwords block that login for 15 minutes.
  - Rule edits show "Last changed by …", and DMs sent from Past comments show who sent them.

## Using the admin panel

- **Instagram:** shows every connected account with its token status, how many auto-replies are active, and DMs sent in the last 7 days.
- **Reels and posts** show likes and comment counts. **Views** need `instagram_manage_insights` too: add it under *Edit permissions* in the Meta login configuration, then reconnect the account. Until then views show as "–".
- **An account's page:**
  - **Auto-replies:** all its rules, with their status and DMs sent.
  - **Your Reels and posts:** a thumbnail grid. Click a post to set up its auto-reply, or to edit an existing one.
  - **+ DM keyword:** a keyword that answers DMs only, with no Reel attached.
  - **Recent activity:** every DM and public reply sent, and every failure with Instagram's reason.
  - **Reconnect / Disconnect.**
- **Rule editor:**
  - Fields: name, keywords, "reply to every comment", link, DM text (`{link}` marks where the link goes), public replies (one per line, picked at random), and an Active switch.
  - **Button first** (Instagram): the message and label of the first DM's button, and "Only send the link to followers" with its own message and button. Button labels are at most 20 characters. The preview shows every step.
  - **Test a comment** checks text against the saved keywords without sending anything.
  - Saving is live immediately; there's nothing to deploy.

The panel is server-rendered HTML with no JavaScript. Its CSP forbids
scripts entirely, and everything from Instagram (captions, usernames,
comments) is HTML-escaped. The session cookie is signed with `ADMIN_KEY`,
lasts 30 days, and is HttpOnly, Secure and SameSite=Strict. Changing
`ADMIN_KEY` logs everyone out.

For scripts, the same data is available as JSON with
`Authorization: Bearer <ADMIN_KEY>`:

```bash
curl -s -H "Authorization: Bearer $ADMIN_KEY" https://<worker>/admin/api/instagram/accounts
curl -s -H "Authorization: Bearer $ADMIN_KEY" "https://<worker>/admin/api/instagram/media?account=llamapresenter"
```

### How matching works

The comment is lowercased, accents are stripped (`é` → `e`), and emoji and
punctuation are removed. A word matches a keyword when it's within:

| keyword length | typos allowed |
|---|---|
| 1–3 letters | 0 |
| 4–7 letters | 1 |
| 8+ letters | 2 |

A swap of two neighbouring letters (`chrsitmas`) counts as one typo, and a
split word is re-joined (`x mas`, `christ mas`). Multi-word keywords like
`"silent night"` work too.

**Choose keywords that aren't one letter away from a common word.** With 1
typo allowed, `link` also matches `line` and `pink`, and `xmas` also matches
`mas`. Long or unusual words (`christmas`, `guide2026`) are safest.

DMs have no Reel attached, so a DM is checked against all of **that
account's** active rules (Reel rules and DM keywords), oldest first. The
first match wins. A DM is never answered with another account's link, and
"reply to every comment" never applies to DMs.

---

## Behaviour and limits

- **One DM per person per Reel for 30 days** (the `ig_sent` table; the claim is atomic, so two simultaneous comments can't both get a DM). A second comment from the same person is ignored, so there's no second public reply either.
- **No "Sent!" without a sent DM.** The public reply is posted only after the private reply succeeds.
- **Rate limits are logged and skipped** (`instagram.comment.rate_limited_skipped`). The dedup claim is released, so the person gets the link if they comment again later.
- **A daily cron cleans up:** dedup rows past 30 days, DM ids past 1 day, activity past 90 days.
- **Your own comments are ignored**, including the Worker's own public replies, which come back as webhooks.
- **Instagram's rules:** one private reply per comment, only within 7 days of the comment. It lands in **Requests** if they don't follow you. Follow-ups are allowed only after they reply, and only within 24h. DM replies must go out within 24h of their message.

### Free-tier budget

| limit | free tier | what uses it |
|---|---|---|
| D1 rows written | 100,000/day | ~2–3 per matched comment (dedup + activity), 2 per matched DM |
| D1 rows read | 5,000,000/day | a few per webhook; the account lookup is cached per isolate |
| Worker requests | 100,000/day | 1 per webhook or panel page |
| Instagram private replies | 750/hour **per account** | 1 per matched comment |

For one person's accounts, Instagram's own limit is the only one you'll hit.

## Tokens

- Each connected account's system-user token is stored in D1 (`ig_accounts`). It's never logged, never shown in the panel, and never returned by any route.
- The tokens **don't expire**. A token stops working only if the connection is removed: you remove the app in Meta Business settings, change the account's password, and so on. Every Graph call then fails with code 190, and the logs add `"hint": "Token revoked: reconnect…"`.
- To fix that, click **Reconnect** on the account's page. **Disconnect** turns its webhooks off and forgets the token. Its auto-replies and history are kept for when it's reconnected.
- Every call sends `appsecret_proof`, so a leaked token is useless without `META_APP_SECRET`. You can turn on **App settings → Advanced → Require App Secret**.

## Opening it up to other people

The code already handles any number of accounts and a public connect link.
What changes is on Meta's side:

- **Advanced Access** for every permission, through **App Review** (screencasts of each permission in use).
- **Business verification** of the portfolio that owns the app. Meta also expects that portfolio to be separate from your clients' portfolios.
- App in **Live** mode, with a privacy policy URL, a 1024px app icon, a category and a business email.
- On our side: customer logins with per-customer data (today the panel has a single admin), and probably Workers Paid.

---

## Local development

```bash
cp .dev.vars.example .dev.vars           # has DRY_RUN=true: nothing is sent to Instagram
npm run db:migrate:local                 # create the tables in local D1
npm run webhook -- seed-account          # fake @llamapresenter + an example auto-reply
npm run dev                              # http://localhost:8787/admin (password: local-admin-key)

# in another terminal
npm run webhook -- verify                              # GET handshake → 200
npm run webhook -- comment "Chrisstmas please 🎄"       # → instagram.graph.dry_run + .comment.dm_sent
npm run webhook -- comment "again" --user 999          # run twice → .comment.already_sent
npm run webhook -- comment "xmas" --media 123          # → .comment.unknown_media
npm run webhook -- comment "xmas" --account 5555       # → .webhook.unknown_account
npm run webhook -- dm "can i get the xmas link"        # → .dm.sent
npm run webhook -- bad-signature                       # → 401
```

Locally the panel shows "Reconnect needed" and can't load posts, because
the seeded token is fake. Rules, activity and the rule editor all work.

```bash
npm test          # matching, rules, signature, escaping, sessions
npm run compile   # tsc --noEmit
```

**Schema changes:** add `migrations/0002_….sql`. `npm run deploy` applies
pending migrations before deploying the code.

## Log events (`npm run tail`)

Every line is JSON with an `event` field and, for webhooks, the `account`.
Filter with `npx wrangler tail --search instagram.comment`.

| event | meaning |
|---|---|
| `instagram.connect.connected` | an account was connected and its webhooks turned on |
| `instagram.connect.subscribe_failed` | connected, but webhook delivery couldn't be switched on |
| `instagram.comment.dm_sent` / `.public_reply_sent` | worked; includes the keyword, the matched word and its distance |
| `instagram.comment.no_match` | the comment was on a configured Reel but had no keyword |
| `instagram.comment.unknown_media` | no auto-reply is set up for this Reel |
| `instagram.comment.rule_disabled` | the Reel's auto-reply is paused |
| `instagram.comment.already_sent` | this person already got this Reel's link in the last 30 days |
| `instagram.comment.skip_own` | your own comment, or the Worker's own public reply |
| `instagram.comment.rate_limited_skipped` | Instagram throttled; skipped, not retried |
| `instagram.comment.dm_failed` | another Graph error; `error.message` and `fbtrace_id` say why |
| `instagram.dm.sent` / `.no_match` / `.skip_own` | the same, for DMs |
| `instagram.dm.follow_asked` | a keyword DM to a followers-only auto-reply, from someone who doesn't follow |
| `instagram.button.link_sent` / `.follow_asked` | someone tapped a button: got the link, or was asked to follow first |
| `instagram.button.rule_disabled` / `.rule_gone` / `.not_ours` | a tap for a paused or deleted auto-reply, or a button we didn't send; nothing is sent |
| `instagram.button.failed` | sending after a tap failed; `error` says why |
| `follow_check_failed` | Instagram couldn't say whether they follow; they got the link anyway |
| `comment.button_refused_sent_link` | Meta refused the button in a private reply, so the link went as plain text |
| `instagram.webhook.unknown_account` | an event for an account that isn't connected (Meta's "Test" button lands here too) |
| `instagram.signature.invalid` | wrong `META_APP_SECRET`; see the note in step 3 |
| `admin.login` / `admin.login_failed` / `admin.rule_*` | admin panel actions |
| `cron.cleanup` | daily housekeeping, with how many rows were removed |

Common Graph errors: **code 190** means the token was revoked, so reconnect.
**Code 10 / 200** is a missing permission, or "Allow access to messages" is
off. A private reply more than 7 days after the comment, or a second one to
the same comment, is rejected by Instagram and shows up as
`instagram.comment.dm_failed`.

## Later

- **Scheduled posts and cross-posting:** a `scheduled_posts` table in the same D1, a page in the panel, and a frequent cron trigger that publishes posts once they're due. Each network publishes through its own `src/<network>/` client. The login configuration already includes `instagram_content_publish`.
- **Backfill:** answer matching comments made before an auto-reply existed. Instagram allows a private reply up to 7 days after a comment.
