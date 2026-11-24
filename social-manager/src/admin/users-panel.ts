/**
 * People and access.
 *
 *   GET  /admin/users              owners: everyone who can log in
 *   POST /admin/users              owners: add a person
 *   GET  /admin/users/<id>         owners: edit name, role, accounts, reset password
 *   POST /admin/users/<id>
 *   POST /admin/users/<id>/delete
 *   GET  /admin/account            anyone: change your own password
 *   POST /admin/account
 */
import { listAccounts } from "../autoreply/db";
import type { Env } from "../env";
import { log } from "../log";
import { NETWORKS, type Network } from "../networks";
import type { Viewer } from "./auth";
import { ago, html, icon, page, redirect, type SafeHtml } from "./html";
import {
  MIN_PASSWORD,
  accessKey,
  createUser,
  deleteUser,
  findUserByLogin,
  getUser,
  grantsFor,
  listUsers,
  normaliseLogin,
  setGrants,
  setPassword,
  updateUser,
  verifyPassword,
  type User,
} from "./users";

const FLASH: Record<string, string> = {
  added: "Person added. Give them their email and password; they can change the password under My account.",
  saved: "Saved.",
  removed: "Removed. Their sessions ended immediately.",
  password: "Password changed. Other sessions with the old password have ended.",
};

const opts = (flash?: string, status?: number) => ({ section: "users", flash, status });

export async function handleUsers(request: Request, url: URL, env: Env, viewer: Viewer): Promise<Response> {
  if (!viewer.owner) return page("Not allowed", html`<h1>Not allowed</h1><p class="lede">Only owners can manage people.</p>`, { status: 403 });
  const parts = url.pathname.split("/").filter(Boolean); // admin, users, [id], [delete]
  const flash = FLASH[url.searchParams.get("msg") ?? ""];
  const post = request.method === "POST";

  if (parts.length === 2) return post ? addUser(request, env) : usersPage(env, viewer, flash);

  const id = Number(parts[2]);
  const user = Number.isInteger(id) ? await getUser(env, id) : null;
  if (!user) return page("Not found", html`<h1>Not found</h1><p class="lede">That person doesn't exist any more.</p>`, { status: 404 });

  if (parts.length === 3) return post ? saveUser(request, env, user, viewer) : editPage(env, user, viewer, flash);
  if (parts[3] === "delete" && post) {
    if (user.id === viewer.id) return editPage(env, user, viewer, undefined, { remove: "You can't remove yourself." }, 400);
    await deleteUser(env, user.id);
    log.info("admin.user_removed", { by: viewer.name, user: user.login });
    return redirect("/admin/users?msg=removed");
  }
  return page("Not found", html`<h1>Not found</h1>`, { status: 404 });
}

// ── List + add ──────────────────────────────────────────────────────────────

async function allAccounts(env: Env) {
  const nets = Object.keys(NETWORKS) as Network[];
  const lists = await Promise.all(nets.map((n) => listAccounts(env, n)));
  return lists.flat();
}

function accountChecks(accounts: Awaited<ReturnType<typeof allAccounts>>, checked: Set<string>): SafeHtml {
  if (!accounts.length) return html`<p class="small muted" style="margin:0">No accounts are connected yet.</p>`;
  return html`<div class="form" style="gap:10px">${accounts.map((a) => {
    const key = accessKey(a.network, a.id);
    return html`<label class="switch" style="padding:10px 14px;border:1px solid var(--rule);border-radius:14px">
      <span><b>${NETWORKS[a.network].display(a.username)}</b><span class="hint">${NETWORKS[a.network].label}</span></span>
      <input type="checkbox" name="access" value="${key}" ${checked.has(key) ? "checked" : ""}></label>`;
  })}</div>`;
}

async function usersPage(env: Env, viewer: Viewer, flash?: string, form?: { values: Record<string, string>; error: string }) {
  const [users, accounts] = await Promise.all([listUsers(env), allAccounts(env)]);
  const v = form?.values ?? {};
  return page(
    "People",
    html`<div class="head"><div><h1>People</h1>
  <p class="lede">Everyone who can log in. Owners see every account and manage people; members only see the accounts you
  give them.</p></div></div>
${users.length
      ? html`<div class="list">${users.map(
          (u) => html`<a class="rule-row" href="/admin/users/${u.id}" style="grid-template-columns:44px minmax(0,1fr) auto auto">
    <span class="avatar" style="width:40px;height:40px;border-radius:12px;font-size:17px">${u.name.slice(0, 1).toUpperCase()}</span>
    <div style="min-width:0"><div class="rule-name">${u.name}${u.id === viewer.id ? html` <span class="muted">(you)</span>` : ""}</div>
      <div class="rule-sub">${u.login}</div></div>
    <span class="small muted">${u.last_login_at ? `Last login ${ago(u.last_login_at)}` : "Never logged in"}</span>
    <span class="chip">${u.role === "owner" ? "Owner" : "Member"}</span>
  </a>`,
        )}</div>`
      : html`<div class="panel empty"><h2>Only the admin key so far</h2>
  <p>Add yourself first as an owner, so you can log in with your email instead of the key.</p></div>`}

<section class="section">
  <div class="section-head"><h2>Add a person</h2><p>You choose their first password. They can change it after logging in.</p></div>
  <form class="panel form" method="post" action="/admin/users">
    ${form ? html`<p class="err" style="margin:0">${form.error}</p>` : ""}
    <label class="field"><span>Name</span><input type="text" name="name" value="${v.name ?? ""}" maxlength="60" required></label>
    <label class="field"><span>Email</span><input type="email" name="email" value="${v.email ?? ""}" autocomplete="off" required>
      <span class="hint">What they type to log in. It doesn't have to match their Facebook email.</span></label>
    <label class="field"><span>Password</span><input type="text" name="password" value="" minlength="${MIN_PASSWORD}" autocomplete="new-password" required>
      <span class="hint">At least ${MIN_PASSWORD} characters. Send it to them privately.</span></label>
    <label class="switch"><span><b>Owner</b><span class="hint">Sees every account and can manage people. Leave off for a member.</span></span>
      <input type="checkbox" name="owner" ${v.owner ? "checked" : ""}></label>
    <div class="field"><span>Accounts a member can see</span>${accountChecks(accounts, new Set((v.access ?? "").split(",").filter(Boolean)))}</div>
    <div class="actions"><button class="btn btn-accent" data-pending="Adding…" data-label="Add person">Add person</button></div>
  </form>
</section>`,
    opts(flash, form ? 400 : 200),
  );
}

async function addUser(request: Request, env: Env) {
  const f = await request.formData();
  const name = String(f.get("name") ?? "").trim();
  const email = normaliseLogin(String(f.get("email") ?? ""));
  const password = String(f.get("password") ?? "");
  const owner = f.has("owner");
  const access = f.getAll("access").map(String);
  const values = { name, email, owner: owner ? "1" : "", access: access.join(",") };
  const fail = (error: string) => usersPage(env, { id: -1, name: "", login: null, owner: true, can: () => true }, undefined, { values, error });

  if (!name) return fail("Add their name.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("Use a valid email address.");
  if (password.length < MIN_PASSWORD) return fail(`The password needs at least ${MIN_PASSWORD} characters.`);
  if (await findUserByLogin(env, email)) return fail("Someone with that email already exists.");

  const id = await createUser(env, { login: email, name, role: owner ? "owner" : "member", password });
  if (!owner) await setGrants(env, id, access);
  log.info("admin.user_added", { user: email, role: owner ? "owner" : "member", accounts: access.length });
  return redirect(`/admin/users/${id}?msg=added`);
}

// ── Edit ────────────────────────────────────────────────────────────────────

async function editPage(env: Env, user: User, viewer: Viewer, flash?: string, errors: Record<string, string> = {}, status = 200) {
  const [accounts, grants] = await Promise.all([allAccounts(env), grantsFor(env, user.id)]);
  const self = user.id === viewer.id;
  return page(
    user.name,
    html`<a class="crumb" href="/admin/users">${icon.arrowLeft} People</a>
<div class="head"><div><h1>${user.name}</h1><p class="lede">${user.login} · ${user.last_login_at ? `last login ${ago(user.last_login_at)}` : "never logged in"}</p></div>
  <span class="chip">${user.role === "owner" ? "Owner" : "Member"}</span></div>
<div class="editor" style="grid-template-columns:minmax(0,1fr)">
<form class="panel form" method="post" action="/admin/users/${user.id}">
  <label class="field"><span>Name</span><input type="text" name="name" value="${user.name}" maxlength="60" required></label>
  <label class="switch"><span><b>Owner</b><span class="hint">Sees every account and can manage people.${self ? " You can't change your own role." : ""}</span></span>
    <input type="checkbox" name="owner" ${user.role === "owner" ? "checked" : ""} ${self ? "disabled" : ""}></label>
  <div class="field"><span>Accounts they can see</span>
    ${user.role === "owner" ? html`<p class="small muted" style="margin:0">Owners see every account.</p>` : accountChecks(accounts, grants)}</div>
  <label class="${errors.password ? "field has-error" : "field"}"><span>New password</span>
    <input type="text" name="password" value="" autocomplete="new-password" placeholder="Leave empty to keep the current one">
    <span class="hint">Setting one signs them out everywhere.</span>${errors.password ? html`<span class="err">${errors.password}</span>` : ""}</label>
  <div class="actions"><button class="btn btn-accent" data-pending="Saving…" data-label="Save changes">Save changes</button>
    <a class="btn btn-ghost" href="/admin/users">Cancel</a></div>
</form>
${self
      ? ""
      : html`<details class="danger"><summary>Remove ${user.name}</summary>
  <form method="post" action="/admin/users/${user.id}/delete" class="confirm">
    <span>They're signed out right away. Their changes stay in the history.</span>
    <button class="btn btn-danger btn-sm">Remove</button></form></details>`}
${errors.remove ? html`<p class="err">${errors.remove}</p>` : ""}
</div>`,
    opts(flash, status),
  );
}

async function saveUser(request: Request, env: Env, user: User, viewer: Viewer) {
  const f = await request.formData();
  const name = String(f.get("name") ?? "").trim() || user.name;
  const self = user.id === viewer.id;
  const role: User["role"] = self ? user.role : f.has("owner") ? "owner" : "member";
  const password = String(f.get("password") ?? "");
  if (password && password.length < MIN_PASSWORD) {
    return editPage(env, user, viewer, undefined, { password: `At least ${MIN_PASSWORD} characters.` }, 400);
  }
  await updateUser(env, user.id, { name, role });
  if (role === "member") await setGrants(env, user.id, f.getAll("access").map(String));
  if (password) await setPassword(env, user.id, password);
  log.info("admin.user_updated", { by: viewer.name, user: user.login, role, password_changed: !!password });
  return redirect(`/admin/users/${user.id}?msg=saved`);
}

// ── My account ──────────────────────────────────────────────────────────────

export async function handleAccount(request: Request, url: URL, env: Env, viewer: Viewer): Promise<Response> {
  const flash = FLASH[url.searchParams.get("msg") ?? ""];
  if (viewer.id <= 0) {
    return page(
      "My account",
      html`<div class="head"><div><h1>My account</h1>
  <p class="lede">You're logged in with the admin key, which has no password to change. Add yourself under
  <a class="textlink" href="/admin/users">People</a> as an owner, then log in with your email.</p></div></div>`,
      { section: "account" },
    );
  }
  const user = await getUser(env, viewer.id);
  if (!user) return redirect("/admin/login");

  let error = "";
  if (request.method === "POST") {
    const f = await request.formData();
    const current = String(f.get("current") ?? "");
    const next = String(f.get("password") ?? "");
    if (!(await verifyPassword(current, user))) error = "Your current password isn't right.";
    else if (next.length < MIN_PASSWORD) error = `The new password needs at least ${MIN_PASSWORD} characters.`;
    else {
      await setPassword(env, user.id, next);
      log.info("admin.password_changed", { user: user.login });
      // This session was signed with the old password too: log in again.
      return redirect("/admin/login?next=%2Fadmin");
    }
  }
  return page(
    "My account",
    html`<div class="head"><div><h1>My account</h1><p class="lede">${user.name} · ${user.login} · ${user.role === "owner" ? "Owner" : "Member"}</p></div></div>
<form class="panel form" method="post" action="/admin/account" style="max-width:520px">
  <label class="field"><span>Current password</span><input type="password" name="current" autocomplete="current-password" required></label>
  <label class="${error ? "field has-error" : "field"}"><span>New password</span>
    <input type="password" name="password" minlength="${MIN_PASSWORD}" autocomplete="new-password" required>
    ${error ? html`<span class="err">${error}</span>` : html`<span class="hint">At least ${MIN_PASSWORD} characters. You'll log in again afterwards.</span>`}</label>
  <div class="actions"><button class="btn btn-accent" data-pending="Saving…" data-label="Change password">Change password</button></div>
</form>`,
    { section: "account", flash, status: error ? 400 : 200 },
  );
}
