/**
 * Instagram pages of the admin panel (auth is checked in index.ts).
 *
 *   GET  /admin/instagram                               connected accounts
 *   GET  /admin/instagram/<user>[?after=]               auto-replies, Reels grid, activity
 *   POST /admin/instagram/<user>/disconnect
 *   GET  /admin/instagram/<user>/rules/new[?media=<id>] new auto-reply (for a Reel, or DM-only)
 *   POST /admin/instagram/<user>/rules/new[?media=<id>]
 *   GET  /admin/instagram/<user>/rules/<id>[?try=…]     edit (+ test a comment)
 *   POST /admin/instagram/<user>/rules/<id>
 *   POST /admin/instagram/<user>/rules/<id>/delete
 */
import { matchComment, validateRule, LIMITS, type RuleInput } from "../autoreply/rules";
import { ago, compact, html, icon, page, redirect, when, type SafeHtml } from "../admin/html";
import type { Env } from "../env";
import { log } from "../log";
import {
  accountStats,
  createRule,
  deleteAccount,
  deleteRule,
  findAccountByUsername,
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
import { pastCommentsPage, sendPastComments } from "./backfill";
import { GraphError, createGraph, type Graph, type MediaItem } from "./graph";

const BASE = "/admin/instagram";
const SECTION = { section: "instagram" };

const FLASH: Record<string, string> = {
  saved: "Saved. It's live now.",
  created: "Auto-reply created. It's live now.",
  deleted: "Auto-reply deleted.",
  disconnected: "Account disconnected. Its auto-replies are kept for when you reconnect it.",
};

export async function handleInstagramPanel(request: Request, url: URL, env: Env): Promise<Response> {
  const parts = url.pathname.slice(BASE.length).split("/").filter(Boolean).map(decodeURIComponent);
  const merged = url.searchParams.getAll("merged").filter(Boolean).slice(0, 10);
  const flash = FLASH[url.searchParams.get("msg") ?? ""]?.concat(
    merged.length
      ? ` Merged ${merged.join(", ")} into the existing keyword${merged.length > 1 ? "s" : ""}: capitals and accents don't matter.`
      : "",
  );
  const post = request.method === "POST";

  if (parts.length === 0) return accountsPage(env, flash);

  const account = await findAccountByUsername(env, parts[0]);
  if (!account) return notFound(`@${parts[0]} isn't connected.`);
  const home = homeOf(account);

  if (parts.length === 1 && !post) return accountPage(url, env, account, flash);
  if (parts[1] === "disconnect" && parts.length === 2 && post) return disconnect(env, account);

  if (parts[1] === "rules") {
    if (parts[2] === "new" && parts.length === 3) {
      const mediaId = url.searchParams.get("media");
      if (mediaId) {
        // One auto-reply per Reel: if it exists, edit that instead.
        const existing = await ruleForMedia(env, account.id, mediaId);
        if (existing) return redirect(`${home}/rules/${existing.id}`);
      }
      return post ? saveNew(request, env, account, mediaId) : ruleEditor(env, account, { mediaId });
    }

    const id = Number(parts[2]);
    const rule = Number.isInteger(id) ? await getRule(env, account.id, id) : null;
    if (!rule) return notFound("This auto-reply doesn't exist any more.");

    if (parts.length === 3 && !post) return ruleEditor(env, account, { rule, flash, tryText: url.searchParams.get("try") });
    if (parts.length === 3 && post) return saveExisting(request, env, account, rule);
    if (parts[3] === "past" && parts.length === 4) {
      return post ? sendPastComments(request, env, account, rule, home) : pastCommentsPage(env, account, rule, home);
    }
    if (parts[3] === "delete" && parts.length === 4 && post) {
      await deleteRule(env, account.id, rule.id);
      log.info("admin.rule_deleted", { account: account.username, rule: rule.name });
      return redirect(`${home}?msg=deleted`);
    }
  }
  return notFound("There's no page at this address.");
}

const homeOf = (a: Account) => `${BASE}/${encodeURIComponent(a.username)}`;

function notFound(message: string): Response {
  return page(
    "Not found",
    html`<div class="head"><div><h1>Not found</h1><p class="lede">${message}</p></div></div>
<a class="btn btn-ghost" href="${BASE}">${icon.arrowLeft} Instagram accounts</a>`,
    { status: 404, ...SECTION },
  );
}

// ── Accounts ────────────────────────────────────────────────────────────────

async function accountsPage(env: Env, flash?: string): Promise<Response> {
  const accounts = await listAccounts(env);
  const cards = await Promise.all(
    accounts.map(async (a) => {
      const [stats, tokenError] = await Promise.all([accountStats(env, a.id), checkToken(env, a)]);
      return html`<a class="panel account" href="${homeOf(a)}">
  <div class="who"><span class="avatar">${a.username.slice(0, 1).toUpperCase()}</span>
    <div><b>@${a.username}</b><span class="small muted">${stats?.last_activity ? `Last reply ${ago(stats.last_activity)}` : "No replies yet"}</span></div></div>
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

  return page(
    "Instagram",
    html`<div class="head"><div><h1>Instagram</h1>
  <p class="lede">Each account answers keyword comments on its Reels with a DM, and replies under the comment.</p></div>
  <a class="btn btn-accent" href="/connect/instagram">${icon.plus} Connect account</a></div>
${accounts.length
      ? html`<div class="accounts">${cards}</div>
<p class="small faint" style="margin-top:28px">Connecting an account again replaces its login and keeps its auto-replies.</p>`
      : html`<div class="panel empty"><h2>Connect your first account</h2>
  <p>You'll log in with Meta and choose which Instagram accounts this tool can reply for.</p>
  <a class="btn btn-accent" href="/connect/instagram">${icon.plus} Connect account</a></div>`}`,
    { flash, ...SECTION },
  );
}

/** null if the token works, else the error message. */
async function checkToken(env: Env, a: Account): Promise<string | null> {
  try {
    await createGraph(env, a.token).profile(a.id);
    return null;
  } catch (err) {
    return errMessage(err);
  }
}

async function disconnect(env: Env, account: Account): Promise<Response> {
  try {
    await createGraph(env, account.token).unsubscribeWebhooks(account.id);
  } catch (err) {
    log.warn("admin.unsubscribe_failed", { account: account.username, error: String(err) });
  }
  await deleteAccount(env, account.id);
  log.info("admin.account_disconnected", { account: account.username });
  return redirect(`${BASE}?msg=disconnected`);
}

// ── Views (need instagram_manage_insights) ──────────────────────────────────

interface Views {
  byId: Map<string, number>;
  /** The token lacks instagram_manage_insights. */
  missingPermission: boolean;
}

/** One insights call per post, in parallel; one broken post doesn't hide the rest. */
async function loadViews(graph: Graph, ids: string[]): Promise<Views> {
  const results = await Promise.allSettled(ids.map((id) => graph.views(id)));
  const byId = new Map<string, number>();
  let permissionErrors = 0;
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value !== null) byId.set(ids[i], r.value);
    else if (r.status === "rejected" && r.reason instanceof GraphError && r.reason.isPermissionError) permissionErrors++;
  });
  return { byId, missingPermission: byId.size === 0 && permissionErrors > 0 };
}

function statsRow(m: MediaItem, views: number | undefined, viewsKnown: boolean): SafeHtml {
  return html`<div class="stats-row">
  <span title="Views">${icon.play}${viewsKnown ? compact(views) : html`<span class="na">–</span>`}</span>
  <span title="Likes">${icon.heart}${compact(m.like_count)}</span>
  <span title="Comments">${icon.comment}${compact(m.comments_count)}</span>
</div>`;
}

const permissionNote = html`<p class="small muted" style="margin:0">Views need the <b>instagram_manage_insights</b> permission:
add it under <i>Edit permissions</i> in your Meta login configuration, then reconnect the account.</p>`;

// ── One account ─────────────────────────────────────────────────────────────

async function accountPage(url: URL, env: Env, account: Account, flash?: string): Promise<Response> {
  const home = homeOf(account);
  const after = url.searchParams.get("after") ?? undefined;
  const graph = createGraph(env, account.token);

  const [rules, counts, events, mediaResult] = await Promise.all([
    listRules(env, account.id),
    sentCountsByRule(env, account.id),
    recentEvents(env, account.id),
    graph.listMedia(account.id, after).then(
      (r) => ({ ok: true as const, r }),
      (err: unknown) => ({ ok: false as const, err }),
    ),
  ]);
  const media = mediaResult.ok ? mediaResult.r.data : [];
  const views = await loadViews(graph, media.map((m) => m.id));
  const mediaById = new Map(media.map((m) => [m.id, m]));
  const byMedia = new Map(rules.filter((r) => r.mediaId).map((r) => [r.mediaId!, r]));

  const graphAlert = mediaResult.ok
    ? ""
    : html`<div class="alert"><b>Couldn't load posts from Instagram.</b> ${errMessage(mediaResult.err)}
  ${mediaResult.err instanceof GraphError && mediaResult.err.isAuthError
        ? html` <a href="/connect/instagram">Reconnect @${account.username}</a> to fix it.`
        : ""}</div>`;

  const rulesList = rules.length
    ? html`<div class="list">${rules.map((r) => ruleRow(home, r, counts, r.mediaId ? mediaById.get(r.mediaId) : undefined))}</div>`
    : html`<div class="panel empty"><h2>No auto-replies yet</h2>
  <p>Pick a Reel below to answer its comments, or add a keyword that answers DMs.</p></div>`;

  const pager =
    mediaResult.ok && (after || mediaResult.r.paging?.next)
      ? html`<div class="pager">${after ? html`<a class="btn btn-ghost btn-sm" href="${home}">${icon.arrowLeft} Newest</a>` : ""}
  ${mediaResult.r.paging?.next && mediaResult.r.paging.cursors?.after
          ? html`<a class="btn btn-ghost btn-sm" href="${home}?after=${mediaResult.r.paging.cursors.after}">Older posts</a>`
          : ""}</div>`
      : "";

  return page(
    `@${account.username}`,
    html`<a class="crumb" href="${BASE}">${icon.arrowLeft} Instagram</a>
<div class="head"><div><h1>@${account.username}</h1>
  <p class="lede">Connected ${when(account.connected_at)}.</p></div>
  <a class="btn btn-ghost" href="${home}/rules/new">${icon.plus} DM keyword</a></div>
${graphAlert}

<section>
  <div class="section-head"><h2>Auto-replies</h2><p>Comments and DMs that match a keyword get your link.</p></div>
  ${rulesList}
</section>

${mediaResult.ok
      ? html`<section class="section">
  <div class="section-head"><h2>Reels and posts</h2><p>Choose one to set up or change its auto-reply.</p></div>
  ${views.missingPermission ? html`<div style="margin:-4px 0 20px">${permissionNote}</div>` : ""}
  <div class="reels">${media.map((m) => reelCard(home, m, byMedia.get(m.id), counts, views))}</div>
  ${pager}
</section>`
      : ""}

<section class="section">
  <div class="section-head"><h2>Activity</h2><p>The latest 30 replies, newest first.</p></div>
  ${activityList(events, home)}
</section>

<section class="section">
  <div class="section-head"><h2>Connection</h2></div>
  <div class="panel flat" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
    <p class="muted" style="margin:0;flex:1;min-width:240px">If replies start failing with "login expired", reconnect. Auto-replies and history are kept.</p>
    <a class="btn btn-ghost btn-sm" href="/connect/instagram">Reconnect</a>
    <details class="danger"><summary>Disconnect</summary>
      <form method="post" action="${home}/disconnect" class="confirm">
        <span>Stop all auto-replies for @${account.username}?</span>
        <button class="btn btn-danger btn-sm">Disconnect</button></form></details>
  </div>
</section>`,
    { flash, ...SECTION },
  );
}

function thumbOf(m: MediaItem | undefined): string | undefined {
  if (!m) return undefined;
  return m.thumbnail_url ?? (m.media_type === "VIDEO" ? undefined : m.media_url);
}

function keywordsOf(r: StoredRule): SafeHtml {
  return r.anyComment
    ? html`<div class="kw"><i>Every comment</i></div>`
    : html`<div class="kw">${r.keywords.map((k) => html`<span>${k}</span>`)}</div>`;
}

function ruleRow(home: string, r: StoredRule, counts: Map<number, number>, m: MediaItem | undefined): SafeHtml {
  const thumb = thumbOf(m);
  return html`<a class="rule-row" href="${home}/rules/${r.id}">
  ${r.mediaId
      ? thumb
        ? html`<img class="rule-thumb" src="${thumb}" alt="" loading="lazy" referrerpolicy="no-referrer">`
        : html`<span class="rule-thumb"></span>`
      : html`<span class="rule-thumb dm">${icon.dm}</span>`}
  <div style="min-width:0"><div class="rule-name">${r.name}</div>
    <div class="rule-sub">${r.mediaId ? "Reel comments and DMs" : "DMs only"}</div></div>
  ${keywordsOf(r)}
  <div class="count">${counts.get(r.id) ?? 0}<small>DMs sent</small></div>
  ${r.enabled
      ? html`<span class="chip"><span class="dot dot-on"></span>On</span>`
      : html`<span class="chip"><span class="dot dot-off"></span>Paused</span>`}
</a>`;
}

function reelCard(home: string, m: MediaItem, rule: StoredRule | undefined, counts: Map<number, number>, views: Views): SafeHtml {
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
    <div class="shade">${status ? html`<div>${status}</div>` : ""}${statsRow(m, views.byId.get(m.id), !views.missingPermission)}</div>
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
          : html`<b>${who}</b> sent a DM, ${e.ok ? "replied" : "reply failed"} from ${rule}`;
    return html`<div class="event">
  <span class="event-icon${e.ok ? "" : " bad"}">${e.kind === "public_reply" ? icon.reply : icon.dm}</span>
  <div style="min-width:0"><div class="event-line">${line}</div>
    ${e.text ? html`<div class="event-text">“${e.text}”</div>` : ""}
    ${e.ok ? "" : html`<div class="event-err">${e.error ?? "Unknown error"}</div>`}</div>
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
};

function toInput(rule: StoredRule): RuleInput {
  return {
    name: rule.name,
    keywords: rule.keywords.join(", "),
    link: rule.link,
    dm: rule.dm,
    publicReplies: rule.publicReplies.join("\n"),
    anyComment: rule.anyComment,
    enabled: rule.enabled,
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
  };
}

async function loadMedia(env: Env, account: Account, mediaId: string) {
  const graph = createGraph(env, account.token);
  try {
    const [media, views] = await Promise.all([graph.media(mediaId), loadViews(graph, [mediaId])]);
    return { media, views };
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
  const sent = rule ? ((await sentCountsByRule(env, account.id)).get(rule.id) ?? 0) : 0;

  const aside = isReel
    ? html`<aside class="aside">
  <div class="phone">
    ${thumb ? html`<img src="${thumb}" alt="" referrerpolicy="no-referrer">` : ""}
    ${media
        ? html`<div class="shade">${statsRow(media, loaded && "views" in loaded ? loaded.views?.byId.get(media.id) : undefined, !(loaded && "views" in loaded && loaded.views?.missingPermission))}</div>`
        : ""}
  </div>
  <div>
    <p class="small faint" style="margin:0 0 6px">Posted ${shortDate(media?.timestamp)}${permalink
        ? html` · <a class="textlink" href="${permalink}" target="_blank" rel="noopener">Open on Instagram</a>`
        : ""}</p>
    ${captionBlock(caption)}
    ${loaded && "error" in loaded ? html`<p class="err">Couldn't load this post: ${loaded.error}</p>` : ""}
  </div>
</aside>`
    : html`<aside class="aside"><div class="panel flat"><span class="rule-thumb dm" style="margin-bottom:16px">${icon.dm}</span>
  <p style="margin:0" class="muted">A DM keyword answers direct messages only. Keywords on your Reels already work in DMs too,
  so use this for words that have no Reel.</p></div></aside>`;

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
    html`<a class="crumb" href="${home}">${icon.arrowLeft} @${account.username}</a>
<div class="head"><div><h1>${title}</h1>
  <p class="lede">${isReel
      ? "Comments with a keyword get your link by DM, and a short reply under their comment."
      : "Messages with a keyword get your link by DM."}</p></div>
  ${rule ? html`<span class="chip">${sent} DMs sent</span>` : ""}</div>

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
      ? html`<label class="switch"><span><b>Reply to every comment</b><span class="hint">Ignore keywords on this Reel.</span></span>
      <input type="checkbox" name="anyComment" ${input.anyComment ? "checked" : ""}></label>`
      : ""}
  </div>

  <div class="group"><p class="group-title">Message</p>
    <label class="${cls("link")}"><span>Link</span>
      <input type="url" name="link" value="${input.link}" placeholder="https://" maxlength="${LIMITS.link}" required>${err("link")}</label>
    <label class="${cls("dm")}"><span>DM</span>
      <textarea name="dm" maxlength="${LIMITS.dm}" required>${input.dm}</textarea>
      <span class="hint">Write <code>{link}</code> where the link goes. Each person gets this once per Reel every 30 days.</span>${err("dm")}</label>
  </div>

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
  <div class="bubble-row"><span class="bubble-av">${account.username.slice(0, 1).toUpperCase()}</span>
    <div class="bubble">${dmBubble(input)}</div></div>
</div>

${rule && rule.mediaId
      ? html`<div class="panel flat" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
  <div style="flex:1;min-width:220px"><h2 style="margin-bottom:6px">Past comments</h2>
    <p class="small muted" style="margin:0">Send the DM to people who commented a keyword before this was set up.
    Instagram allows it for comments up to 7 days old.</p></div>
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
    { flash: opts.flash, status: opts.status, ...SECTION },
  );
}

async function saveNew(request: Request, env: Env, account: Account, mediaId: string | null): Promise<Response> {
  const input = readForm(await request.formData());
  const result = validateRule(input, mediaId !== null);
  if (!result.ok) return ruleEditor(env, account, { mediaId, input, errors: result.errors, status: 400 });

  let snapshot: { permalink?: string; caption?: string } = {};
  if (mediaId) {
    const loaded = await loadMedia(env, account, mediaId);
    if (!("media" in loaded) || !loaded.media) {
      return ruleEditor(env, account, {
        mediaId,
        input,
        errors: { name: `Couldn't confirm this post belongs to @${account.username}: ${"error" in loaded ? loaded.error : ""}` },
        status: 400,
      });
    }
    snapshot = { permalink: loaded.media.permalink, caption: loaded.media.caption?.slice(0, 500) };
  }
  const id = await createRule(env, account.id, mediaId, result.rule, snapshot);
  log.info("admin.rule_created", { account: account.username, rule: result.rule.name, media_id: mediaId });
  return redirect(`${homeOf(account)}/rules/${id}?${flashQuery("created", result.merged)}`);
}

async function saveExisting(request: Request, env: Env, account: Account, rule: StoredRule): Promise<Response> {
  const input = readForm(await request.formData());
  const result = validateRule(input, rule.mediaId !== null);
  if (!result.ok) return ruleEditor(env, account, { rule, input, errors: result.errors, status: 400 });
  await updateRule(env, account.id, rule.id, result.rule);
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
