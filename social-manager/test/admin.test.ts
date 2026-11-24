import { describe, expect, it } from "vitest";
import { checkSession, makeSession, sameOrigin } from "../src/admin/auth";
import { hashPassword, verifyPassword } from "../src/admin/users";
import { html, raw } from "../src/admin/html";

describe("html", () => {
  it("escapes interpolated values", () => {
    const caption = `<script>alert("x")</script> & 'q'`;
    expect(html`<p>${caption}</p>`.value).toBe(
      "<p>&#60;script&#62;alert(&#34;x&#34;)&#60;/script&#62; &#38; &#39;q&#39;</p>",
    );
  });

  it("escapes inside attributes, so a value can't break out of quotes", () => {
    expect(html`<a href="${'x" onclick="evil()'}">`.value).toBe('<a href="x&#34; onclick=&#34;evil()">');
  });

  it("nests html/raw unescaped, joins arrays, drops null/false", () => {
    const items = ["<a>", "b"].map((s) => html`<li>${s}</li>`);
    expect(html`<ul>${items}</ul>${null}${false}${raw("<hr>")}`.value).toBe("<ul><li>&#60;a&#62;</li><li>b</li></ul><hr>");
  });
});

describe("admin session", () => {
  const key = "k".repeat(48);
  const stamps: Record<number, string | null> = { 0: "key", 7: "salt-a" };
  const stampFor = async (uid: number) => stamps[uid] ?? null;

  it("identifies the user until the cookie expires", async () => {
    const now = Date.now();
    const s = await makeSession(key, 7, "salt-a", now);
    expect(await checkSession(key, s, stampFor, now)).toBe(7);
    expect(await checkSession(key, s, stampFor, now + 31 * 24 * 3600 * 1000)).toBeNull();
  });

  it("ends a user's sessions when their password (salt) changes or they're removed", async () => {
    const s = await makeSession(key, 7, "salt-a");
    expect(await checkSession(key, s, async () => "salt-b")).toBeNull();
    expect(await checkSession(key, s, async () => null)).toBeNull();
  });

  it("rejects another key, a forged user id or expiry, and garbage", async () => {
    const s = await makeSession(key, 7, "salt-a");
    expect(await checkSession("other", s, stampFor)).toBeNull();
    const [, exp, sig] = s.split(".");
    expect(await checkSession(key, `0.${exp}.${sig}`, stampFor)).toBeNull();
    expect(await checkSession(key, `7.${Date.now() + 10 ** 12}.${sig}`, stampFor)).toBeNull();
    expect(await checkSession(key, "nope", stampFor)).toBeNull();
    expect(await checkSession(key, null, stampFor)).toBeNull();
  });

  it("supports the admin-key session (user 0)", async () => {
    expect(await checkSession(key, await makeSession(key, 0, "key"), stampFor)).toBe(0);
  });
});

describe("passwords", () => {
  it("verifies the right password and rejects others", async () => {
    const pw = await hashPassword("correct horse battery", undefined, 1000);
    const user = { pw_hash: pw.hash, pw_salt: pw.salt, pw_iter: pw.iterations };
    expect(await verifyPassword("correct horse battery", user)).toBe(true);
    expect(await verifyPassword("correct horse batterY", user)).toBe(false);
  });

  it("salts every hash differently", async () => {
    const [a, b] = await Promise.all([hashPassword("same", undefined, 1000), hashPassword("same", undefined, 1000)]);
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("sameOrigin", () => {
  const url = new URL("https://sm.example/admin/login");
  const req = (headers: Record<string, string>) => new Request(url, { method: "POST", headers });

  it("trusts Sec-Fetch-Site over Origin (Chrome sends Origin: null under no-referrer)", () => {
    expect(sameOrigin(req({ "Sec-Fetch-Site": "same-origin", Origin: "null" }), url)).toBe(true);
    expect(sameOrigin(req({ "Sec-Fetch-Site": "cross-site", Origin: "https://sm.example" }), url)).toBe(false);
  });

  it("falls back to Origin", () => {
    expect(sameOrigin(req({ Origin: "https://sm.example" }), url)).toBe(true);
    expect(sameOrigin(req({ Origin: "https://evil.example" }), url)).toBe(false);
    expect(sameOrigin(req({ Origin: "null" }), url)).toBe(false);
  });
});
