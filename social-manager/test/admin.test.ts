import { describe, expect, it } from "vitest";
import { checkSession, makeSession, sameOrigin } from "../src/admin/auth";
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

  it("accepts its own cookie until it expires", async () => {
    const now = Date.now();
    const s = await makeSession(key, now);
    expect(await checkSession(key, s, now)).toBe(true);
    expect(await checkSession(key, s, now + 31 * 24 * 3600 * 1000)).toBe(false);
  });

  it("rejects a cookie signed with another key, a forged expiry, or garbage", async () => {
    const s = await makeSession(key);
    expect(await checkSession("other", s)).toBe(false);
    const [, sig] = s.split(".");
    expect(await checkSession(key, `${Date.now() + 10 ** 12}.${sig}`)).toBe(false);
    expect(await checkSession(key, "nope")).toBe(false);
    expect(await checkSession(key, null)).toBe(false);
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
