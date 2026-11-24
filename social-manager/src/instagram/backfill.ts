/**
 * "Past comments": answer comments made before an auto-reply existed (or
 * while it was paused / webhooks weren't set up).
 *
 *   GET  /admin/instagram/<user>/rules/<id>/past   preview: who would get the DM. Sends nothing.
 *   POST /admin/instagram/<user>/rules/<id>/past   send to the ticked comments, at most BATCH per click.
 *
 * Instagram's rules decide what's possible: one private reply per comment,
 * and only within 7 days of the comment. So the preview only lists comments
 * from the last 7 days, one per person, skipping people who already got this
 * Reel's DM (the same `ig_sent` claim the webhook uses, so neither path can
 * double-send).
 *
 * BATCH keeps one click under the free plan's 50 outgoing requests per
 * invocation: each person costs a DM call plus, optionally, a public reply.
 */
import { matchComment, pickPublicReply, renderDm } from "../autoreply/rules";
import { ago, html, icon, page, type SafeHtml } from "../admin/html";
import type { Env } from "../env";
import { log } from "../log";
import { claimSent, recordEvent, releaseSent, sentUserIds, type Account, type StoredRule } from "./db";
import { GraphError, createGraph, type IgComment } from "./graph";

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Instagram rejects replies right at the edge; leave a margin. */
const SAFE_WINDOW_MS = WINDOW_MS - 10 * 60 * 1000;
const MAX_PAGES = 10;
const BATCH = 20;

interface Candidate {
  commentId: string;
  userId: string;
  username: string;
  text: string;
  at: string;
  keyword: string;
}

interface Scan {
  eligible: Candidate[];
  alreadySent: number;
  noMatch: number;
  tooOld: number;
  own: number;
  /** Stopped at MAX_PAGES: there may be more. */
  truncated: boolean;
}

/**
 * Decide, for a batch of comments (newest first, replies included), who can
 * still get the DM. Pure, so it is unit-tested: this is what sends real DMs.
 */
export function classifyComments(
  comments: IgComment[],
  rule: Pick<StoredRule, "keywords" | "anyComment" | "id" | "mediaId" | "name" | "link" | "dm" | "publicReplies" | "enabled">,
  account: Pick<Account, "id" | "username">,
  alreadySent: Set<string>,
  now = Date.now(),
): Omit<Scan, "truncated"> {
  const cutoff = now - SAFE_WINDOW_MS;
  const result: Omit<Scan, "truncated"> = { eligible: [], alreadySent: 0, noMatch: 0, tooOld: 0, own: 0 };
  const seenUsers = new Set<string>();
  const all = comments.flatMap((c) => [c, ...(c.replies?.data ?? [])]);
  // Oldest first, so a person's *first* matching comment is the one answered.
  all.sort((a, b) => Date.parse(a.timestamp ?? "") - Date.parse(b.timestamp ?? ""));

  for (const c of all) {
    const userId = c.from?.id;
    const username = c.from?.username ?? c.username ?? "";
    if (!userId || !c.timestamp) continue;
    if (userId === account.id || username.toLowerCase() === account.username.toLowerCase()) {
      result.own++;
      continue;
    }
    if (Date.parse(c.timestamp) < cutoff) {
      result.tooOld++;
      continue;
    }
    const hit = matchComment({ ...rule, id: rule.id }, c.text ?? "");
    if (!hit) {
      result.noMatch++;
      continue;
    }
    if (alreadySent.has(userId) || seenUsers.has(userId)) {
      result.alreadySent++;
      continue;
    }
    seenUsers.add(userId);
    result.eligible.push({ commentId: c.id, userId, username, text: c.text ?? "", at: c.timestamp, keyword: hit.keyword });
  }
  result.eligible.reverse(); // show newest first
  return result;
}

async function scan(env: Env, account: Account, rule: StoredRule): Promise<Scan> {
  const graph = createGraph(env, account.token);
  const sent = await sentUserIds(env, rule.mediaId!);
  const cutoff = Date.now() - SAFE_WINDOW_MS;
  const comments: IgComment[] = [];

  let after: string | undefined;
  let truncated = true;
  for (let pageNo = 0; pageNo < MAX_PAGES; pageNo++) {
    const res = await graph.comments(rule.mediaId!, after);
    comments.push(...res.data);
    after = res.paging?.next ? res.paging.cursors?.after : undefined;
    // Newest first: once a whole page is past the window, older pages are too.
    const pastWindow = res.data.every((c) => c.timestamp && Date.parse(c.timestamp) < cutoff);
    if (!after || pastWindow) {
      truncated = false;
      break;
    }
  }
  return { ...classifyComments(comments, rule, account, sent), truncated };
}

export async function pastCommentsPage(
  env: Env,
  account: Account,
  rule: StoredRule,
  home: string,
  report?: SafeHtml,
): Promise<Response> {
  const back = html`<a class="crumb" href="${home}/rules/${rule.id}">${icon.arrowLeft} ${rule.name}</a>`;
  if (!rule.mediaId) {
    return page("Past comments", html`${back}<div class="head"><div><h1>Past comments</h1>
  <p class="lede">DM keywords have no comments to look back on.</p></div></div>`, { section: "instagram", status: 400 });
  }

  let s: Scan;
  try {
    s = await scan(env, account, rule);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return page(
      "Past comments",
      html`${back}<div class="head"><div><h1>Past comments</h1></div></div>
<div class="alert"><b>Couldn't load comments from Instagram.</b> ${msg}${
        err instanceof GraphError && err.isPermissionError
          ? html` The connection needs the <b>instagram_manage_comments</b> permission; reconnect the account.`
          : ""
      }</div>`,
      { section: "instagram", status: 502 },
    );
  }

  const skipped = [
    s.alreadySent && `${s.alreadySent} already got it`,
    s.noMatch && `${s.noMatch} without a keyword`,
    s.tooOld && `${s.tooOld} older than 7 days (Instagram no longer allows a reply)`,
    s.own && `${s.own} from @${account.username} (your own comments and auto-replies)`,
  ].filter(Boolean);

  const list = s.eligible.length
    ? html`<form method="post" action="${home}/rules/${rule.id}/past" class="form">
  <div class="list">${s.eligible.map(
    (c, i) => html`<label class="event" style="cursor:pointer">
    <input type="checkbox" name="c" value="${c.commentId}|${c.userId}" ${i < BATCH ? "checked" : ""} style="margin-top:10px;accent-color:#fcdf50;width:18px;height:18px">
    <div style="min-width:0"><div class="event-line"><b>@${c.username}</b> <span class="muted">matched “${c.keyword}”</span></div>
      <div class="event-text">“${c.text}”</div></div>
    <time datetime="${c.at}">${ago(c.at)}</time>
    <input type="hidden" name="u_${c.commentId}" value="${c.username}">
    <input type="hidden" name="t_${c.commentId}" value="${c.text.slice(0, 200)}">
  </label>`,
  )}</div>
  ${rule.publicReplies.length
      ? html`<label class="switch panel flat" style="padding:16px 20px"><span><b>Also reply under their comment</b>
      <span class="hint">Uses one of your public replies, like for new comments.</span></span>
      <input type="checkbox" name="publicReply" checked></label>`
      : ""}
  <div class="actions">
    <button class="btn btn-accent" data-pending="Sending…" data-label="Send the DM to the ticked people">Send the DM to the ticked people</button>
    <span class="small muted">Up to ${BATCH} per click${s.eligible.length > BATCH ? `; the first ${BATCH} are ticked` : ""}.</span>
  </div>
</form>`
    : html`<div class="panel empty"><h2>Nobody to send to</h2>
  <p>${s.alreadySent
      ? "Everyone who commented a keyword in the last 7 days already got the DM."
      : `Nobody has commented ${rule.anyComment ? "" : `“${rule.keywords.join("”, “")}” `}on this Reel in the last 7 days.`}</p></div>`;

  return page(
    "Past comments",
    html`${back}
<div class="head"><div><h1>Past comments</h1>
  <p class="lede">People who commented a keyword in the last 7 days but haven't had the DM yet. Instagram allows one DM
  per comment, within 7 days of it.</p></div>
  <span class="chip chip-accent">${s.eligible.length} can still get it</span></div>
${report ?? ""}
${skipped.length ? html`<p class="small muted" style="margin:-16px 0 24px">Skipped: ${skipped.join(" · ")}.</p>` : ""}
${s.truncated ? html`<p class="small muted" style="margin:-16px 0 24px">Showing the newest ${MAX_PAGES * 50} comments.</p>` : ""}
${list}`,
    { section: "instagram" },
  );
}

export async function sendPastComments(
  request: Request,
  env: Env,
  account: Account,
  rule: StoredRule,
  home: string,
): Promise<Response> {
  const form = await request.formData();
  const picks = form
    .getAll("c")
    .map(String)
    .map((v) => v.split("|"))
    .filter((p): p is [string, string] => p.length === 2 && /^\d+$/.test(p[0]) && /^\d+$/.test(p[1]))
    .slice(0, BATCH);
  const withPublicReply = form.has("publicReply");
  const graph = createGraph(env, account.token);
  const dm = renderDm(rule);

  let sent = 0;
  let stopped: string | null = null;
  const failures: string[] = [];
  for (const [commentId, userId] of picks) {
    const username = String(form.get(`u_${commentId}`) ?? "");
    const text = String(form.get(`t_${commentId}`) ?? "");
    if (!(await claimSent(env, rule.mediaId!, userId, commentId))) continue; // got it meanwhile
    const base = { accountId: account.id, ruleId: rule.id, mediaId: rule.mediaId!, username, text, keyword: "past comment" };
    try {
      await graph.privateReply(account.id, commentId, dm);
      sent++;
      await recordEvent(env, { ...base, kind: "comment_dm", ok: true });
    } catch (err) {
      await releaseSent(env, rule.mediaId!, userId, commentId);
      const msg = err instanceof GraphError ? err.advice : err instanceof Error ? err.message : String(err);
      await recordEvent(env, { ...base, kind: "comment_dm", ok: false, error: msg });
      // Account-wide problems: the rest would fail the same way. Stop and say so once.
      if (err instanceof GraphError && (err.isRateLimit || err.isAuthError || err.isMessagingDisabled)) {
        stopped = msg;
        break;
      }
      failures.push(`@${username}: ${msg}`);
      continue;
    }
    const reply = withPublicReply ? pickPublicReply(rule) : null;
    if (reply) {
      try {
        await graph.replyToComment(commentId, reply);
        await recordEvent(env, { ...base, kind: "public_reply", ok: true, text: reply, username: undefined });
      } catch (err) {
        await recordEvent(env, { ...base, kind: "public_reply", ok: false, text: reply, error: String(err) });
      }
    }
  }
  log.info("instagram.past_comments.sent", { account: account.username, rule: rule.name, sent, failed: failures.length });

  const report = html`<p class="flash" role="status"><span class="dot ${failures.length || stopped ? "dot-bad" : "dot-on"}"></span>
  Sent ${sent} DM${sent === 1 ? "" : "s"}.${failures.length ? ` ${failures.length} failed.` : ""}${stopped ? " Stopped: nothing else was sent." : ""}</p>
${stopped ? html`<div class="alert"><b>Nobody else got a DM.</b> ${stopped} Then send again: everyone below is still waiting.</div>` : ""}
${failures.length ? html`<div class="alert">${failures.map((f) => html`<div>${f}</div>`)}</div>` : ""}`;
  return pastCommentsPage(env, account, rule, home, report);
}
