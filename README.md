# X-Grow

An AI copilot for growing your X (Twitter) account, as a single Chrome
extension. No server, no database, no account — it runs entirely in your
browser and calls OpenAI with **your own API key**.

- Injects **✨ AI** buttons into x.com to generate replies and posts in your
  voice, then inserts them into X's own composer.
- Ships a full dashboard in the toolbar popup — voice profile, schedule,
  settings — with an ↗ button to open the same thing in a full tab.
- Reads tweets and engagement counts straight out of the rendered page, so
  there is no paid X API tier to buy.

The AI is **assist-only**: it drafts, *you* click Post.

---

## Architecture

```
Chrome extension ──HTTPS──▶ OpenAI API
  content script            (your key, from
    ✨ buttons on x.com      chrome.storage.local)
  popup + dashboard tab
    the whole UI, off-page
  background worker  ◀── owns the key, owns every write
  IndexedDB          ◀── voice profile, generations, schedule, inspiration
```

Everything lives in the extension:

| Concern | Where |
| --- | --- |
| OpenAI key, model, base URL | `chrome.storage.local` (background worker only) |
| Voice profile, generations, schedule, creators, inspiration posts | IndexedDB (`lib/db`) |
| Prompts | `lib/ai/prompts.ts` |
| x.com DOM | `lib/xdom.ts` |

There is no sync and no backup but the one you export yourself — see
**Settings → Backup**.

---

## Prerequisites

- Node 18+ and npm
- Google Chrome
- An OpenAI API key

---

## Run it

```bash
cd extension
npm install
npm run dev            # builds to .output/chrome-mv3 and watches
# or a one-off production build:
npm run build
```

**Load it in Chrome:**

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. **Load unpacked** → select `extension/.output/chrome-mv3`

**Connect your X account:** open x.com and click the X-Grow icon in the
toolbar. It reads the account you're already signed in to and asks you to
confirm — *Continue as @you*. There is no OAuth, no password and no developer
app: the extension runs inside your own session, so it just needs to know which
account it's writing for.

**Add your key:** paste your OpenAI key in the same popup and hit Save — it's
verified against the API before it's stored.

**Set your voice:** open the popup, go to *Voice profile*,
and hit **Learn my voice** — it opens a small window, scrolls your own profile,
and turns your real posts into a voice guide. Pasting a handful of your best
tweets into *Your best posts* does the same job by hand, and is the single
biggest factor in sounding like you.

---

## Use it on X

1. Go to **x.com**.
2. Open a tweet's reply box, or the composer. A ✨ button appears next to
   Reply/Post.
3. Click it:
   - On a reply → 5 replies in your voice, from the tweet and its thread.
   - On the composer → give a topic, pick a format (single / hook / thread).
4. Click **Insert** → it drops into X's box → **you** review and Post.

---

## Project layout

```
extension/
  wxt.config.ts               manifest: permissions, host_permissions, matches
  entrypoints/
    background.ts             owns the OpenAI key; the only context that calls OpenAI
    content.ts                injects the ✨ buttons; observes X's SPA
    popup/                    the dashboard, in the toolbar popup (800x600)
    dashboard/                the same dashboard, in a full tab
  lib/
    ai/openai.ts              Chat Completions wrapper
    ai/prompts.ts             every prompt + the TONES/POST_FORMATS/POST_CATEGORIES enums
    db/                       IndexedDB schema and repositories
    dashboard/                the dashboard UI: React + Tailwind, one codebase
    panel.ts                  the on-page options panel (vanilla DOM, styled as X's)
    xdom.ts                   ALL x.com DOM selectors + text insertion
    xtheme.ts / xstyles.ts    X's live theme, measured off the page
    scoring.ts                inspiration ranking against each creator's own mean
    time.ts                   wall-clock scheduling helpers
```

---

## Notes & known limits

- **X's DOM changes often** and is obfuscated. When buttons stop appearing or
  text stops inserting, the fix is almost always in `lib/xdom.ts` (the
  `data-testid` selectors). It's deliberately the single source of X-DOM truth.
- **Text insertion** drives X's Draft.js editor with a synthetic paste, with
  `beforeinput`/`input` events as a fallback.
- **Threads**: a "thread" option is inserted as one block of text (tweets
  separated by blank lines) for you to split — X has no single-call thread
  composer in the DOM.
- **Harvesting needs a visible window.** Chrome throttles background tabs and X
  only loads timeline content it believes is on screen, so "Harvest all" opens a
  real popup window and takes focus while it runs.
- **A custom OpenAI base URL** (a proxy or a compatible provider) also needs its
  host added to `host_permissions` in `wxt.config.ts`.
- **Terms of Service**: this is assist-only (a human posts).

## Scheduling

**Schedule** in the dashboard gives you a month/week calendar. The month grid
needs more room than the 800x600 popup allows, so hit ↗ to open it in a tab. *Generate week*
writes a whole week of drafts in one OpenAI call, spread across the hours you
pick with at least an hour between posts.

Nothing publishes until you **approve** it — that's the one place you opt a
specific piece of text into auto-posting. Approved posts go out through X's own
composer in a small window that flashes open, so there's no OAuth app and no
paid X API tier.

What that costs you, stated plainly:

- **It only fires while Chrome is running.** A post whose time passed while
  Chrome was closed goes out late, not never.
- **The publish window takes focus** for a few seconds. Chrome throttles
  background tabs and X won't drive a composer it thinks is off screen.
- **Failures don't retry.** The post is marked failed with the reason, and you
  fix and re-approve. You get a notification either way.
- **Editing an approved post's text drops it back to draft.** Moving it in time
  doesn't — the same approved text still goes out.
- **If X is signed in as a different account** when a post comes due, it fails
  rather than posting as the wrong person.

## Inspiration

**Inspiration** tracks creators and surfaces the posts that beat *their own*
average — ranked against each creator's baseline, so a 500-like post from
someone who averages 50 outranks a 2k-like post from someone who averages 5k.

Add anyone by @handle; no X API and no connection to them is needed. Posts get
collected three ways, all free:

- the **✨ Harvest** button on their profile,
- **passively**, as you read a tracked creator's profile (it never scrolls the
  page you're using),
- **Update data**, which walks every tracked creator in one window.

Every tweet in your timeline also gets a **remix button** in its action row, so
you can rewrite anything you scroll past without tracking its author first —
three versions, then Copy or Save as draft.

**Remix** rewrites a viral post in your voice — pick how close to stay to the
original (*Build on original* / *Balanced* / *Make it mine*), add any steer,
get three versions, edit, then queue it, post it now, or save it as a draft.
The original creator is never mentioned.

## Roadmap

- **History** — a browsable log of every generation. The data is already
  recorded, including which post a remix came from; only the screen is missing.
