/**
 * Settings (owners).
 *
 *   GET  /admin/settings   the texts every new auto-reply starts with
 *   POST /admin/settings
 *
 * Saved auto-replies keep their own texts; these only fill in new ones.
 */
import { BUILT_IN, ruleDefaults, saveRuleDefaults, validateDefaults, type RuleDefaults } from "../autoreply/defaults";
import { LIMITS } from "../autoreply/rules";
import type { Env } from "../env";
import { log } from "../log";
import type { Viewer } from "./auth";
import { html, page, redirect } from "./html";

const opts = (flash?: string, status?: number) => ({ section: "settings", flash, status });

export async function handleSettings(request: Request, url: URL, env: Env, viewer: Viewer): Promise<Response> {
  if (!viewer.owner)
    return page("Not allowed", html`<h1>Not allowed</h1><p class="lede">Only owners can change settings.</p>`, { status: 403 });

  if (request.method === "POST") {
    const f = await request.formData();
    const s = (k: string) => String(f.get(k) ?? "");
    const d: RuleDefaults = {
      link: s("link").trim(),
      dm: s("dm"),
      publicReplies: s("publicReplies"),
      buttonFirst: f.has("buttonFirst"),
      opener: s("opener"),
      button: s("button"),
      followFirst: f.has("followFirst"),
      followText: s("followText"),
      followButton: s("followButton"),
    };
    // "Reset" puts the built-in texts back.
    const next = f.has("reset") ? { ...BUILT_IN } : d;
    const errors = validateDefaults(next);
    if (Object.keys(errors).length) return settingsPage(next, errors, undefined, 400);
    await saveRuleDefaults(env, next, viewer.name);
    log.info("admin.settings_saved", { by: viewer.name, reset: f.has("reset") });
    return redirect(`/admin/settings?msg=${f.has("reset") ? "reset" : "saved"}`);
  }

  const msg = url.searchParams.get("msg");
  const flash =
    msg === "saved"
      ? "Saved. New auto-replies start with these texts."
      : msg === "reset"
        ? "Back to the built-in texts."
        : undefined;
  return settingsPage(await ruleDefaults(env), {}, flash);
}

function settingsPage(d: RuleDefaults, errors: Record<string, string>, flash?: string, status = 200): Response {
  const err = (k: string) => (errors[k] ? html`<span class="err">${errors[k]}</span>` : "");
  const cls = (k: string) => (errors[k] ? "field has-error" : "field");

  return page(
    "Settings",
    html`<div class="head"><div><h1>Settings</h1>
  <p class="lede">The texts every new auto-reply starts with. You can still change them per auto-reply, and the ones
  you've already saved keep their own.</p></div></div>

<form class="panel form" method="post" action="/admin/settings" style="max-width:760px">
  <div class="group"><p class="group-title">Message</p>
    <label class="${cls("link")}"><span>Link</span>
      <input type="url" name="link" value="${d.link}" placeholder="https://" maxlength="${LIMITS.link}">
      <span class="hint">Optional. Fill it in if most of your posts send the same link.</span>${err("link")}</label>
    <label class="${cls("dm")}"><span>DM</span>
      <textarea name="dm" maxlength="${LIMITS.dm}" required>${d.dm}</textarea>
      <span class="hint">Write <code>{link}</code> where the link goes.</span>${err("dm")}</label>
  </div>

  <div class="group"><p class="group-title">Public reply</p>
    <label class="${cls("publicReplies")}"><span>Replies under the comment</span>
      <textarea name="publicReplies">${d.publicReplies}</textarea>
      <span class="hint">One per line, picked at random. Leave empty to start without replies. DM keywords never use these.</span>${err("publicReplies")}</label>
  </div>

  <div class="group gate"><p class="group-title">Button first (Instagram)</p>
    <label class="switch"><span><b>Ask them to tap a button first</b><span class="hint">New Instagram auto-replies start with this switched on.</span></span>
      <input type="checkbox" name="buttonFirst" ${d.buttonFirst ? "checked" : ""}></label>
    <div class="reveal">
      <label class="${cls("opener")}"><span>Message with the button</span>
        <textarea name="opener" maxlength="${LIMITS.opener}">${d.opener}</textarea>${err("opener")}</label>
      <label class="${cls("button")}"><span>Button</span>
        <input type="text" name="button" value="${d.button}" maxlength="${LIMITS.button}">
        <span class="hint">Up to ${LIMITS.button} characters.</span>${err("button")}</label>
      <label class="switch"><span><b>Only send the link to followers</b></span>
        <input type="checkbox" name="followFirst" ${d.followFirst ? "checked" : ""}></label>
      <div class="reveal-follow">
        <label class="${cls("followText")}"><span>Message if they don't follow</span>
          <textarea name="followText" maxlength="${LIMITS.opener}">${d.followText}</textarea>${err("followText")}</label>
        <label class="${cls("followButton")}"><span>Button</span>
          <input type="text" name="followButton" value="${d.followButton}" maxlength="${LIMITS.button}">${err("followButton")}</label>
      </div>
    </div>
  </div>

  <div class="actions"><button class="btn btn-accent" data-pending="Saving…" data-label="Save defaults">Save defaults</button>
    <button class="btn btn-ghost" name="reset" value="1" formnovalidate>Reset to built-in texts</button></div>
</form>`,
    opts(flash, status),
  );
}
