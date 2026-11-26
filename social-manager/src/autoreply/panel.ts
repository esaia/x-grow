/**
 * The admin pages for one network's auto-replies (auth is checked in index.ts).
 * Every network gets the same pages; NETWORKS supplies the words and the client.
 *
 *   GET  /admin/<network>                                   connected accounts / Pages
 *   GET  /admin/<network>/<id>[?after=]                     auto-replies, posts grid, activity
 *   POST /admin/<network>/<id>/disconnect
 *   GET  /admin/<network>/<id>/rules/new[?media=<post id>]  new auto-reply (for a post, or DM-only)
 *   POST /admin/<network>/<id>/rules/new[?media=<post id>]
 *   GET  /admin/<network>/<id>/rules/<rule>[?try=…]         edit (+ test a comment)
 *   POST /admin/<network>/<id>/rules/<rule>
 *   GET  /admin/<network>/<id>/rules/<rule>/past            past comments (backfill)
 *   POST /admin/<network>/<id>/rules/<rule>/delete
 */
import type { Viewer } from "../admin/auth";
import { ago, compact, html, icon, page, redirect, when, type SafeHtml } from "../admin/html";
import type { Env } from "../env";
import { log } from "../log";
import { GraphError } from "../meta";
import { NETWORKS, type Network, type Post } from "../networks";
import { pastCommentsPage, sendPastComments } from "./backfill";
import {
  accountStats,
  createRule,
  deleteAccount,
  deleteRule,
  getAccount,
  getRule,
  listAccounts,
  listRules,
  recentEvents,
  ruleForMedia,
  sentCountsByRule,
  updateRule,
  type Account,
  type EventRow,
  type StoredRule,
} from "./db";
import { matchComment, validateRule, LIMITS, type RuleInput } from "./rules";

const baseOf = (n: Network) => `/admin/${n}`;
const section = (n: Network) => ({ section: n });
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const FLASH: Record<string, string> = {
  saved: "Saved. It's live now.",
  created: "Auto-reply created. It's live now.",
  deleted: "Auto-reply deleted.",
  disconnected: "Account disconnected. Its auto-replies are kept for when you reconnect it.",
};

export async function handlePanel(request: Request, url: URL, env: Env, network: Network, viewer: Viewer): Promise<Response> {
  const parts = url.pathname.slice(baseOf(network).length).split("/").filter(Boolean).map(decodeURIComponent);
  const merged = url.searchParams.getAll("merged").filter(Boolean).slice(0, 10);
  const flash = FLASH[url.searchParams.get("msg") ?? ""]?.concat(
    merged.length
      ? ` Merged ${merged.join(", ")} into the existing keyword${merged.length > 1 ? "s" : ""}: capitals and accents don't matter.`
      : "",
  );
  const post = request.method === "POST";

  if (parts.length === 0) return accountsPage(env, network, viewer, flash);

  let account = await getAccount(env, network, parts[0]);
  // Members only reach the accounts an owner gave them; anything else looks like it doesn't exist.
  if (account && !viewer.can(network, account.id)) account = null;
  if (!account) {
    // Links used to use the username (/admin/instagram/llamapresenter); send old bookmarks on.
    const byName = (await listAccounts(env, network)).find(
      (a) => a.username.toLowerCase() === parts[0].toLowerCase() && viewer.can(network, a.id),
    );
    if (byName) return redirect(url.pathname.replace(`/${parts[0]}`, `/${encodeURIComponent(byName.id)}`) + url.search);
  }
  if (!account) return notFound(network, `This ${NETWORKS[network].label} ${NETWORKS[network].accountNoun} isn't connected.`);
  const home = homeOf(account);

  if (parts.length === 1 && !post) return accountPage(url, env, account, viewer, flash);
  if (parts[1] === "disconnect" && parts.length === 2 && post) {
    if (!viewer.owner) return notFound(network, "Only owners can disconnect accounts.");
    return disconnect(env, account);
  }

  if (parts[1] === "rules") {
    if (parts[2] === "new" && parts.length === 3) {
      const mediaId = url.searchParams.get("media");
      if (mediaId) {
        // One auto-reply per Reel: if it exists, edit that instead.
        const existing = await ruleForMedia(env, account, mediaId);
        if (existing) return redirect(`${home}/rules/${existing.id}`);
      }
      return post ? saveNew(request, env, account, mediaId, viewer) : ruleEditor(env, account, { mediaId });
    }

    const id = Number(parts[2]);
    const rule = Number.isInteger(id) ? await getRule(env, account, id) : null;
    if (!rule) return notFound(network, "This auto-reply doesn't exist any more.");

    if (parts.length === 3 && !post) return ruleEditor(env, account, { rule, flash, tryText: url.searchParams.get("try") });
    if (parts.length === 3 && post) return saveExisting(request, env, account, rule, viewer);
    if (parts[3] === "past" && parts.length === 4) {
      return post ? sendPastComments(request, env, account, rule, home, viewer.name) : pastCommentsPage(env, account, rule, home);
    }
    if (parts[3] === "delete" && parts.length === 4 && post) {
      await deleteRule(env, account, rule.id);
      log.info("admin.rule_deleted", { account: account.username, rule: rule.name, by: viewer.name });
      return redirect(`${home}?msg=deleted`);
    }
  }
  return notFound(network, "There's no page at this address.");
}

const homeOf = (a: Account) => `${baseOf(a.network)}/${encodeURIComponent(a.id)}`;

function notFound(network: Network, message: string): Response {
  return page(
    "Not found",
    html`<div class="head"><div><h1>Not found</h1><p class="lede">${message}</p></div></div>
<a class="btn btn-ghost" href="${baseOf(network)}">${icon.arrowLeft} ${NETWORKS[network].label}</a>`,
    { status: 404, ...section(network) },
  );
}

// ── Accounts ────────────────────────────────────────────────────────────────

async function accountsPage(env: Env, network: Network, viewer: Viewer, flash?: string): Promise<Response> {
  const info = NETWORKS[network];
  const accounts = (await listAccounts(env, network)).filter((a) => viewer.can(network, a.id));
  const cards = await Promise.all(
    accounts.map(async (a) => {
      const [stats, tokenError] = await Promise.all([accountStats(env, a), checkToken(env, a)]);
      return html`<a class="panel account" href="${homeOf(a)}">
  <div class="who"><span class="avatar">${a.username.slice(0, 1).toUpperCase()}</span>
    <div><b>${info.display(a.username)}</b><span class="small muted">${stats?.last_activity ? `Last reply ${ago(stats.last_activity)}` : "No replies yet"}</span></div></div>
  <div class="figures">
    <div class="figure"><b>${stats?.active_rules ?? 0}</b><span>active auto-replies</span></div>
    <div class="figure"><b>${stats?.dms_7d ?? 0}</b><span>DMs sent this week</span></div>
  </div>
  <div>${tokenError
        ? html`<span class="chip"><span class="dot dot-bad"></span>Needs reconnecting</span>`
        : html`<span class="chip"><span class="dot dot-on"></span>Connected</span>`}</div>
</a>`;
    }),
  );

  const lede =
    network === "facebook"
      ? "Each Page answers keyword comments on its posts with a Messenger DM, and replies under the comment."
      : "Each account answers keyword comments on its Reels with a DM, and replies under the comment.";
  const connect = viewer.owner
    ? html`<a class="btn btn-accent" href="/connect/${network}">${icon.plus} Connect ${info.accountNoun}</a>`
    : "";
  return page(
    info.label,
    html`<div class="head"><div><h1>${info.label}</h1><p class="lede">${lede}</p></div>${connect}</div>
${accounts.length
      ? html`<div class="accounts">${cards}</div>
<p class="small faint" style="margin-top:28px">Connecting again replaces the login and keeps the auto-replies.</p>`
      : viewer.owner
        ? html`<div class="panel empty"><h2>Connect your first ${info.accountNoun}</h2>
  <p>You'll log in with Meta and choose which ${info.label} ${info.accountNoun}s this tool can reply for.</p>${connect}</div>`
        : html`<div class="panel empty"><h2>No ${info.label} ${info.accountNoun}s for you yet</h2>
  <p>An owner can give you access under People.</p></div>`}`,
    { flash, ...section(network) },
  );
}

/** null if the token works, else the error message. */
async function checkToken(env: Env, a: Account): Promise<string | null> {
  try {
    await NETWORKS[a.network].client(env, a).check();
    return null;
  } catch (err) {
    return errMessage(err);
  }
}

async function disconnect(env: Env, account: Account): Promise<Response> {
  try {
    await NETWORKS[account.network].client(env, account).unsubscribe();
  } catch (err) {
    log.warn("admin.unsubscribe_failed", { account: account.username, error: String(err) });
  }
  await deleteAccount(env, account.network, account.id);
  log.info("admin.account_disconnected", { network: account.network, account: account.username });
  return redirect(`${baseOf(account.network)}?msg=disconnected`);
}

// ── Stats ─────────────────────────────────────────────────────────────────

function statsRow(p: Post, likesLabel: string): SafeHtml {
  return html`<div class="stats-row">
  ${p.views === undefined ? "" : html`<span title="Views">${icon.play}${p.views === null ? html`<span class="na">–</span>` : compact(p.views)}</span>`}
  <span title="${likesLabel}">${icon.heart}${compact(p.likes)}</span>
  <span title="Comments">${icon.comment}${compact(p.comments)}</span>
</div>`;
}

const permissionNote = (permission: string, noun: string, network: Network) => html`<p class="small muted" style="margin:0">Views need the
<b>${permission}</b> permission: add it to the app and to your Meta login configuration, then reconnect the ${noun}.${
  network === "facebook" ? " Facebook also only reports views for Pages with 100 or more likes." : ""
}</p>`;

// ── One account ─────────────────────────────────────────────────────────────

async function accountPage(url: URL, env: Env, account: Account, viewer: Viewer, flash?: string): Promise<Response> {
  const home = homeOf(account);
  const info = NETWORKS[account.network];
  const base = baseOf(account.network);
  const after = url.searchParams.get("after") ?? undefined;
  const client = info.client(env, account);

  const [rules, counts, events, mediaResult] = await Promise.all([
    listRules(env, account),
    sentCountsByRule(env, account),
    recentEvents(env, account),
    client.posts(after).then(
      (r) => ({ ok: true as const, r }),
      (err: unknown) => ({ ok: false as const, err }),
    ),
  ]);
  const media = mediaResult.ok ? mediaResult.r.items : [];
  const likesLabel = account.network === "facebook" ? "Reactions" : "Likes";
  const mediaById = new Map(media.map((m) => [m.id, m]));
  const byMedia = new Map(rules.filter((r) => r.mediaId).map((r) => [r.mediaId!, r]));

  const graphAlert = mediaResult.ok
    ? ""
    : html`<div class="alert"><b>Couldn't load posts from ${info.label}.</b> ${errMessage(mediaResult.err)}
  ${mediaResult.err instanceof GraphError && mediaResult.err.isAuthError
        ? html` <a href="/connect/${account.network}">Reconnect ${info.display(account.username)}</a> to fix it.`
        : ""}</div>`;

  const rulesList = rules.length
    ? html`<div class="list">${newestFirst(rules, mediaById).map((r) => ruleRow(home, r, counts, r.mediaId ? mediaById.get(r.mediaId) : undefined, info.postNoun))}</div>`
    : html`<div class="panel empty"><h2>No auto-replies yet</h2>
  <p>Pick a ${info.postNoun} below to answer its comments, or add a keyword that answers DMs.</p></div>`;

  const pager =
    mediaResult.ok && (after || mediaResult.r.after)
      ? html`<div class="pager">${after ? html`<a class="btn btn-ghost btn-sm" href="${home}">${icon.arrowLeft} Newest</a>` : ""}
  ${mediaResult.r.after
          ? html`<a class="btn btn-ghost btn-sm" href="${home}?after=${mediaResult.r.after}">Older posts</a>`
          : ""}</div>`
      : "";

  return page(
    info.display(account.username),
    html`<a class="crumb" href="${base}">${icon.arrowLeft} ${info.label}</a>
<div class="head"><div><h1>${info.display(account.username)}</h1>
  <p class="lede">Connected ${when(account.connected_at)}.</p></div>
  <a class="btn btn-ghost" href="${home}/rules/new">${icon.plus} DM keyword</a></div>
${graphAlert}

<section>
  <div class="section-head"><h2>Auto-replies</h2><p>Comments and DMs that match a keyword get your link.</p></div>
  ${rulesList}
</section>

${mediaResult.ok
      ? html`<section class="section">
  <div class="section-head"><h2>${info.postsTitle}</h2><p>Choose one to set up or change its auto-reply.</p></div>
  ${mediaResult.r.viewsNeedPermission ? html`<div style="margin:-4px 0 20px">${permissionNote(info.viewsPermission, info.accountNoun, account.network)}</div>` : ""}
  <div class="reels">${media.map((m) => reelCard(home, m, byMedia.get(m.id), counts, likesLabel))}</div>
  ${pager}
</section>`
      : ""}

<section class="section">
  <div class="section-head"><h2>Activity</h2><p>The latest 30 replies, newest first.</p></div>
  ${activityList(events, home)}
</section>

${viewer.owner
      ? html`<section class="section">
  <div class="section-head"><h2>Connection</h2></div>
  <div class="panel flat" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
    <p class="muted" style="margin:0;flex:1;min-width:240px">If replies start failing with "login expired", reconnect. Auto-replies and history are kept.</p>
    <a class="btn btn-ghost btn-sm" href="/connect/${account.network}">Reconnect</a>
    <details class="danger"><summary>Disconnect</summary>
      <form method="post" action="${home}/disconnect" class="confirm">
        <span>Stop all auto-replies for ${info.display(account.username)}?</span>
        <button class="btn btn-danger btn-sm">Disconnect</button></form></details>
  </div>
</section>`
      : ""}`,
    { flash, ...section(account.network) },
  );
}

/**
 * Auto-replies in the order their posts were published, newest first, like the
 * grid below. A post's date is only known when it is in the loaded page of
 * posts; those older than that follow, newest rule first, then DM keywords.
 * Display only: DM keyword ties are still broken oldest rule first (listRules).
 */
export function newestFirst<R extends Pick<StoredRule, "mediaId" | "createdAt">>(
  rules: R[],
  mediaById: Map<string, Pick<Post, "timestamp">>,
): R[] {
  const rank = (r: R): [number, string] => {
    if (!r.mediaId) return [2, r.createdAt];
    const posted = mediaById.get(r.mediaId)?.timestamp;
    return posted ? [0, new Date(posted).toISOString()] : [1, r.createdAt];
  };
  return rules
    .map((r) => ({ r, k: rank(r) }))
    .sort((a, b) => a.k[0] - b.k[0] || (a.k[1] < b.k[1] ? 1 : a.k[1] > b.k[1] ? -1 : 0))
    .map((x) => x.r);
}

function thumbOf(m: Post | undefined): string | undefined {
  return m?.thumbnail;
}

function keywordsOf(r: StoredRule): SafeHtml {
  return r.anyComment
    ? html`<div class="kw"><i>Every comment</i></div>`
    : html`<div class="kw">${r.keywords.map((k) => html`<span>${k}</span>`)}</div>`;
}

function ruleRow(home: string, r: StoredRule, counts: Map<number, number>, m: Post | undefined, postNoun: string): SafeHtml {
  const thumb = thumbOf(m);
  return html`<a class="rule-row" href="${home}/rules/${r.id}">
  ${r.mediaId
      ? thumb
        ? html`<img class="rule-thumb" src="${thumb}" alt="" loading="lazy" referrerpolicy="no-referrer">`
        : html`<span class="rule-thumb"></span>`
      : html`<span class="rule-thumb dm">${icon.dm}</span>`}
  <div style="min-width:0"><div class="rule-name">${r.name}</div>
    <div class="rule-sub">${r.mediaId ? `${cap(postNoun)} comments and DMs` : "DMs only"}</div></div>
  ${keywordsOf(r)}
  <div class="count">${counts.get(r.id) ?? 0}<small>DMs sent</small></div>
  ${r.enabled
      ? html`<span class="chip"><span class="dot dot-on"></span>On</span>`
      : html`<span class="chip"><span class="dot dot-off"></span>Paused</span>`}
</a>`;
}

function reelCard(home: string, m: Post, rule: StoredRule | undefined, counts: Map<number, number>, likesLabel: string): SafeHtml {
  const href = rule ? `${home}/rules/${rule.id}` : `${home}/rules/new?media=${encodeURIComponent(m.id)}`;
  const img = thumbOf(m);
  const live = rule?.enabled;
  const status = !rule
    ? ""
    : live
      ? html`<span class="chip"><span class="dot dot-on"></span>${counts.get(rule.id) ?? 0} DMs sent</span>`
      : html`<span class="chip"><span class="dot dot-off"></span>Paused</span>`;
  return html`<a class="reel${live ? " is-live" : ""}" href="${href}">
  <div class="phone">
    ${img ? html`<img src="${img}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}
    <div class="shade">${status ? html`<div>${status}</div>` : ""}${statsRow(m, likesLabel)}</div>
    <div class="tap"><span>${rule ? "Edit auto-reply" : "Set up auto-reply"}</span></div>
  </div>
  <div class="cap">${m.caption ?? "No caption"}</div>
  <div class="date">${shortDate(m.timestamp)}</div>
</a>`;
}

function activityList(events: EventRow[], home: string): SafeHtml {
  if (!events.length)
    return html`<div class="panel empty"><h2>Nothing yet</h2><p>When someone comments or DMs a keyword, the reply shows up here.</p></div>`;
  return html`<div class="list">${events.map((e) => {
    const who = e.username ? `@${e.username}` : "Someone";
    const rule = e.rule_id && e.rule_name ? html`<a class="textlink" href="${home}/rules/${e.rule_id}">${e.rule_name}</a>` : "an auto-reply";
    const line =
      e.kind === "public_reply"
        ? html`${e.ok ? "Replied" : "Couldn't reply"} under the comment for ${rule}`
        : e.kind === "comment_dm"
          ? html`<b>${who}</b> commented, ${e.ok ? "sent the DM" : "DM failed"} from ${rule}`
          : e.kind === "link_dm"
            ? html`<b>${who}</b> tapped the button, ${e.ok ? "sent the link" : "link failed"} from ${rule}`
            : e.kind === "follow_ask"
              ? html`<b>${who}</b> doesn't follow yet, asked them to follow first for ${rule}`
              : html`<b>${who}</b> sent a DM, ${e.ok ? "replied" : "reply failed"} from ${rule}`;
    return html`<div class="event">
  <span class="event-icon${e.ok ? "" : " bad"}">${e.kind === "public_reply" ? icon.reply : icon.dm}</span>
  <div style="min-width:0"><div class="event-line">${line}</div>
    ${e.text ? html`<div class="event-text">“${e.text}”</div>` : ""}
    ${e.actor ? html`<div class="small faint" style="margin-top:3px">Sent by ${e.actor} from past comments</div>` : ""}
    ${e.ok
      ? e.error
        ? html`<div class="small faint" style="margin-top:3px">${e.error}</div>`
        : ""
      : html`<div class="event-err">${e.error ?? "Unknown error"}</div>`}</div>
  <time datetime="${e.at}" title="${when(e.at)}">${ago(e.at)}</time>
</div>`;
  })}</div>`;
}

// ── Rule editor ─────────────────────────────────────────────────────────────

const DEFAULTS: RuleInput = {
  name: "",
  keywords: "",
  link: "",
  dm: "Here's the link you asked for 👇\n{link}",
  publicReplies: [
    "Sent! 📩 Check your DMs (or message requests)",
    "Just sent it 📩 Look in your message requests",
    "Done! 📩 It's in your DMs",
  ].join("\n"),
  anyComment: false,
  enabled: true,
  buttonFirst: false,
  opener: "Hey! Tap below and I'll send you the link 👇",
  button: "Send me the link",
  followFirst: false,
  followText: "Looks like you're not following me yet 👀 Follow, then tap below and the link is yours.",
  followButton: "I'm following",
};

function toInput(rule: StoredRule): RuleInput {
  const g = rule.gate;
  return {
    name: rule.name,
    keywords: rule.keywords.join(", "),
    link: rule.link,
    dm: rule.dm,
    publicReplies: rule.publicReplies.join("\n"),
    anyComment: rule.anyComment,
    enabled: rule.enabled,
    // Switched off, the texts keep their defaults, so switching on starts from something.
    buttonFirst: !!g,
    opener: g?.opener ?? DEFAULTS.opener,
    button: g?.button ?? DEFAULTS.button,
    followFirst: !!g?.follow,
    followText: g?.follow?.text ?? DEFAULTS.followText,
    followButton: g?.follow?.button ?? DEFAULTS.followButton,
  };
}

function readForm(form: FormData): RuleInput {
  const s = (k: string) => String(form.get(k) ?? "");
  return {
    name: s("name"),
    keywords: s("keywords"),
    link: s("link"),
    dm: s("dm"),
    publicReplies: s("publicReplies"),
    anyComment: form.has("anyComment"),
    enabled: form.has("enabled"),
    buttonFirst: form.has("buttonFirst"),
    opener: s("opener"),
    button: s("button"),
    followFirst: form.has("followFirst"),
    followText: s("followText"),
    followButton: s("followButton"),
  };
}

async function loadMedia(env: Env, account: Account, mediaId: string) {
  try {
    return { media: await NETWORKS[account.network].client(env, account).post(mediaId) };
  } catch (err) {
    return { error: errMessage(err) };
  }
}

/** The DM as a chat bubble, with the link drawn as a link. */
function dmBubble(input: RuleInput): SafeHtml {
  const dm = input.dm.trim() || DEFAULTS.dm;
  const link = input.link.trim() || "https://…";
  const parts = dm.split("{link}");
  return html`${parts.map((p, i) => html`${p}${i < parts.length - 1 ? html`<span class="link">${link}</span>` : ""}`)}`;
}

/**
 * The button steps of the preview, drawn when "Button first" is on. Without
 * JavaScript the preview shows what was last saved or submitted, like the rest
 * of it.
 */
function gatePreview(enabled: boolean, input: RuleInput, username: string): SafeHtml | string {
  if (!enabled || !input.buttonFirst) return "";
  const av = html`<span class="bubble-av">${username.slice(0, 1).toUpperCase()}</span>`;
  const step = (text: string, button: string, fallback: string) => html`<div class="bubble-row">${av}
    <div class="bubble">${text.trim() || fallback}<span class="bubble-btn">${button.trim() || "Button"}</span></div></div>
  <div class="bubble-row me"><div class="bubble me">${button.trim() || "Button"}</div></div>`;
  return html`${step(input.opener, input.button, DEFAULTS.opener)}
  ${input.followFirst
    ? html`<p class="small faint" style="margin:0">If they don't follow you yet:</p>
  ${step(input.followText, input.followButton, DEFAULTS.followText)}
  <p class="small faint" style="margin:0">Once they follow:</p>`
    : ""}`;
}

async function ruleEditor(
  env: Env,
  account: Account,
  opts: {
    rule?: StoredRule;
    mediaId?: string | null;
    input?: RuleInput;
    errors?: Record<string, string>;
    flash?: string;
    tryText?: string | null;
    status?: number;
  },
): Promise<Response> {
  const { rule } = opts;
  const home = homeOf(account);
  const info = NETWORKS[account.network];
  const mediaId = rule ? rule.mediaId : (opts.mediaId ?? null);
  const isReel = mediaId !== null;
  const loaded = mediaId ? await loadMedia(env, account, mediaId) : null;
  const media = loaded && "media" in loaded ? loaded.media : undefined;
  const caption = media?.caption ?? rule?.caption ?? "";
  const input =
    opts.input ??
    (rule ? toInput(rule) : { ...DEFAULTS, name: firstLine(caption), publicReplies: isReel ? DEFAULTS.publicReplies : "" });
  const errors = opts.errors ?? {};
  const err = (k: string) => (errors[k] ? html`<span class="err">${errors[k]}</span>` : "");
  const cls = (k: string) => (errors[k] ? "field has-error" : "field");
  const action = rule ? `${home}/rules/${rule.id}` : `${home}/rules/new${mediaId ? `?media=${encodeURIComponent(mediaId)}` : ""}`;
  const title = rule ? rule.name : isReel ? "New auto-reply" : "New DM keyword";
  const permalink = media?.permalink ?? rule?.permalink;
  const thumb = thumbOf(media);
  const sent = rule ? ((await sentCountsByRule(env, account)).get(rule.id) ?? 0) : 0;

  const aside = isReel
    ? html`<aside class="aside">
  <div class="phone">
    ${thumb ? html`<img src="${thumb}" alt="" referrerpolicy="no-referrer">` : ""}
    ${media
        ? html`<div class="shade">${statsRow(media, account.network === "facebook" ? "Reactions" : "Likes")}</div>`
        : ""}
  </div>
  <div>
    <p class="small faint" style="margin:0 0 6px">Posted ${shortDate(media?.timestamp)}${permalink
        ? html` · <a class="textlink" href="${permalink}" target="_blank" rel="noopener">Open on ${info.label}</a>`
        : ""}</p>
    ${captionBlock(caption)}
    ${loaded && "error" in loaded ? html`<p class="err">Couldn't load this post: ${loaded.error}</p>` : ""}
  </div>
</aside>`
    : html`<aside class="aside"><div class="panel flat"><span class="rule-thumb dm" style="margin-bottom:16px">${icon.dm}</span>
  <p style="margin:0" class="muted">A DM keyword answers direct messages only. Keywords on your ${info.postNoun}s already work in
  DMs too, so use this for words that have no ${info.postNoun}.</p></div></aside>`;

  let verdict: SafeHtml | string = "";
  if (rule && opts.tryText) {
    const hit = matchComment(rule, opts.tryText);
    verdict = hit
      ? html`<p class="verdict"><span class="dot dot-on"></span>Matches <b>${hit.keyword}</b>${hit.distance
          ? html`<span class="muted">, read “${hit.matched}” as a typo</span>`
          : ""}. This comment would get the DM.</p>`
      : html`<p class="verdict"><span class="dot dot-off"></span>No keyword found. This comment wouldn't get the DM.</p>`;
  }

  const firstReply = input.publicReplies.split("\n").map((l) => l.trim()).find(Boolean);
  const sampleComment = input.anyComment ? "Love this 🔥" : (input.keywords.split(",")[0]?.trim() || "your keyword");

  return page(
    title,
    html`<a class="crumb" href="${home}">${icon.arrowLeft} ${info.display(account.username)}</a>
<div class="head"><div><h1>${title}</h1>
  <p class="lede">${isReel
      ? "Comments with a keyword get your link by DM, and a short reply under their comment."
      : "Messages with a keyword get your link by DM."}</p></div>
  ${rule ? html`<span class="chip">${sent} DMs sent</span>` : ""}</div>
${rule?.updatedBy ? html`<p class="small faint" style="margin:-28px 0 28px">Last changed by ${rule.updatedBy} ${ago(rule.updatedAt)}</p>` : ""}

<div class="editor">
${aside}
<div class="form">
<form class="panel form" method="post" action="${action}">
  <label class="switch"><span><b>Active</b><span class="hint">Pause to stop replying without deleting anything.</span></span>
    <input type="checkbox" name="enabled" ${input.enabled ? "checked" : ""}></label>

  <div class="group"><p class="group-title">Trigger</p>
    <label class="${cls("name")}"><span>Name</span>
      <input type="text" name="name" value="${input.name}" maxlength="${LIMITS.name}" required>
      <span class="hint">Just for you, in the activity list.</span>${err("name")}</label>
    <label class="${cls("keywords")}"><span>Keywords</span>
      <input type="text" name="keywords" value="${input.keywords}" placeholder="christmas, xmas">
      <span class="hint">Separate with commas. Capitals, accents, emoji and small typos don't matter, so <i>template</i>
        also catches <i>TEMPLATE</i> and <i>templte</i>. Words of 3 letters or fewer must match exactly.</span>${err("keywords")}</label>
    ${isReel
      ? html`<label class="switch"><span><b>Reply to every comment</b><span class="hint">Ignore keywords on this ${info.postNoun}.</span></span>
      <input type="checkbox" name="anyComment" ${input.anyComment ? "checked" : ""}></label>`
      : ""}
  </div>

  <div class="group"><p class="group-title">Message</p>
    <label class="${cls("link")}"><span>Link</span>
      <input type="url" name="link" value="${input.link}" placeholder="https://" maxlength="${LIMITS.link}" required>${err("link")}</label>
    <label class="${cls("dm")}"><span>DM</span>
      <textarea name="dm" maxlength="${LIMITS.dm}" required>${input.dm}</textarea>
      <span class="hint">Write <code>{link}</code> where the link goes. Each person gets this once per ${info.postNoun} every 30 days.</span>${err("dm")}</label>
  </div>

  ${isReel && info.buttons
      ? html`<div class="group gate"><p class="group-title">Button first</p>
    <label class="switch"><span><b>Ask them to tap a button first</b><span class="hint">The DM is a short message with a button,
      and the link comes when they tap it. Tapping opens the chat, so the link lands in their inbox rather than message requests.</span></span>
      <input type="checkbox" name="buttonFirst" ${input.buttonFirst ? "checked" : ""}></label>
    <div class="reveal">
      <label class="${cls("opener")}"><span>Message with the button</span>
        <textarea name="opener" maxlength="${LIMITS.opener}">${input.opener}</textarea>${err("opener")}</label>
      <label class="${cls("button")}"><span>Button</span>
        <input type="text" name="button" value="${input.button}" maxlength="${LIMITS.button}">
        <span class="hint">Up to ${LIMITS.button} characters.</span>${err("button")}</label>
      <label class="switch"><span><b>Only send the link to followers</b><span class="hint">When they tap, ${info.label} tells us
        whether they follow you. If not, they get the message below with a button to tap once they do.</span></span>
        <input type="checkbox" name="followFirst" ${input.followFirst ? "checked" : ""}></label>
      <div class="reveal-follow">
        <label class="${cls("followText")}"><span>Message if they don't follow</span>
          <textarea name="followText" maxlength="${LIMITS.opener}">${input.followText}</textarea>${err("followText")}</label>
        <label class="${cls("followButton")}"><span>Button</span>
          <input type="text" name="followButton" value="${input.followButton}" maxlength="${LIMITS.button}">${err("followButton")}</label>
      </div>
    </div>
  </div>`
      : ""}

  ${isReel
      ? html`<div class="group"><p class="group-title">Public reply</p>
    <label class="${cls("publicReplies")}"><span>Replies under the comment</span>
      <textarea name="publicReplies">${input.publicReplies}</textarea>
      <span class="hint">One per line, picked at random so they don't all read the same. Leave empty to skip.</span>${err("publicReplies")}</label>
  </div>`
      : ""}

  <div class="actions"><button class="btn btn-accent" data-pending="Saving…" data-label="${rule ? "Save changes" : "Create auto-reply"}">${rule ? "Save changes" : "Create auto-reply"}</button>
    <a class="btn btn-ghost" href="${home}">Cancel</a></div>
</form>

<div class="convo">
  <span class="convo-label">What they get</span>
  ${isReel
      ? html`<div class="comment"><b>someone</b> ${sampleComment}</div>
  ${firstReply ? html`<div class="comment reply"><b>${account.username}</b> ${firstReply}</div>` : ""}`
      : ""}
  ${gatePreview(isReel && info.buttons, input, account.username)}
  <div class="bubble-row"><span class="bubble-av">${account.username.slice(0, 1).toUpperCase()}</span>
    <div class="bubble">${dmBubble(input)}</div></div>
</div>

${rule && rule.mediaId
      ? html`<div class="panel flat" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
  <div style="flex:1;min-width:220px"><h2 style="margin-bottom:6px">Past comments</h2>
    <p class="small muted" style="margin:0">Send the DM to people who commented a keyword before this was set up.
    ${info.label} allows it for comments up to 7 days old.</p></div>
  <a class="btn btn-ink" href="${home}/rules/${rule.id}/past">Check past comments</a>
</div>`
      : ""}
${rule
      ? html`<div class="panel flat">
  <h2 style="margin-bottom:6px">Try a comment</h2>
  <p class="small muted" style="margin:0 0 16px">Checks the saved keywords. Nothing is sent.</p>
  <form method="get" action="${home}/rules/${rule.id}" class="tester">
    <input type="text" name="try" value="${opts.tryText ?? ""}" placeholder="Chrisstmas please 🎄" aria-label="Comment to test">
    <button class="btn btn-ink">Check</button></form>${verdict}
</div>
<details class="danger"><summary>Delete this auto-reply</summary>
  <form method="post" action="${home}/rules/${rule.id}/delete" class="confirm">
    <span>Its history stays in the activity list.</span><button class="btn btn-danger btn-sm">Delete</button></form></details>`
      : ""}
</div>
</div>`,
    { flash: opts.flash, status: opts.status, ...section(account.network) },
  );
}

async function saveNew(request: Request, env: Env, account: Account, mediaId: string | null, viewer: Viewer): Promise<Response> {
  const input = readForm(await request.formData());
  const result = validateRule(input, mediaId !== null, NETWORKS[account.network].buttons);
  if (!result.ok) return ruleEditor(env, account, { mediaId, input, errors: result.errors, status: 400 });

  let snapshot: { permalink?: string; caption?: string } = {};
  if (mediaId) {
    const loaded = await loadMedia(env, account, mediaId);
    if (!("media" in loaded) || !loaded.media) {
      return ruleEditor(env, account, {
        mediaId,
        input,
        errors: { name: `Couldn't confirm this post belongs to ${NETWORKS[account.network].display(account.username)}: ${"error" in loaded ? loaded.error : ""}` },
        status: 400,
      });
    }
    snapshot = { permalink: loaded.media.permalink, caption: loaded.media.caption?.slice(0, 500) };
  }
  const id = await createRule(env, account, mediaId, result.rule, snapshot, viewer.name);
  log.info("admin.rule_created", { network: account.network, account: account.username, rule: result.rule.name, media_id: mediaId });
  return redirect(`${homeOf(account)}/rules/${id}?${flashQuery("created", result.merged)}`);
}

async function saveExisting(request: Request, env: Env, account: Account, rule: StoredRule, viewer: Viewer): Promise<Response> {
  const input = readForm(await request.formData());
  const result = validateRule(input, rule.mediaId !== null, NETWORKS[account.network].buttons);
  if (!result.ok) return ruleEditor(env, account, { rule, input, errors: result.errors, status: 400 });
  await updateRule(env, account, rule.id, result.rule, viewer.name);
  log.info("admin.rule_updated", { account: account.username, rule: result.rule.name });
  return redirect(`${homeOf(account)}/rules/${rule.id}?${flashQuery("saved", result.merged)}`);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function flashQuery(msg: string, merged: string[]): string {
  const q = new URLSearchParams({ msg });
  for (const m of merged) q.append("merged", m);
  return q.toString();
}

/**
 * The Reel's caption in the editor. Long captions are clipped with a
 * "See all" toggle: a <details> element, so it works without JavaScript.
 */
function captionBlock(caption: string): SafeHtml {
  if (!caption) return html``;
  const long = caption.length > 160 || caption.split("\n").length > 4;
  if (!long) return html`<div class="cap">${caption}</div>`;
  return html`<details class="cap-toggle"><summary><span class="cap">${caption}</span>
  <span class="more" aria-hidden="true"></span></summary></details>`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Default name for a new auto-reply: the caption's first line, cut at a whole word. */
export function firstLine(caption: string): string {
  const line = (caption.split("\n").find((l) => l.trim()) ?? "").trim();
  if (line.length <= 40) return line;
  const cut = line.slice(0, 40);
  const space = cut.lastIndexOf(" ");
  return (space > 15 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?–-]+$/, "");
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function shortDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
