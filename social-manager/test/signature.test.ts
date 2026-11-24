import { describe, expect, it } from "vitest";
import { sign, verifySignature } from "../src/signature";

const body = JSON.stringify({ object: "instagram", entry: [] });
const buf = new TextEncoder().encode(body).buffer as ArrayBuffer;

describe("verifySignature", () => {
  it("accepts Meta's escaped-unicode signature for a body with emoji / non-Latin text", async () => {
    const rawBody = JSON.stringify({ text: "christmas 🎄 შობა / link" });
    const escaped = rawBody.replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
    const rawBuf = new TextEncoder().encode(rawBody).buffer as ArrayBuffer;
    const secrets = [{ name: "APP_SECRET", value: "s3cret" }];
    expect(await verifySignature(rawBuf, await sign(escaped, "s3cret"), secrets)).toBe("APP_SECRET");
    expect(await verifySignature(rawBuf, await sign(escaped.replaceAll("/", "\\/"), "s3cret"), secrets)).toBe("APP_SECRET");
    expect(await verifySignature(rawBuf, await sign(escaped, "wrong"), secrets)).toBeNull();
  });

  it("accepts a correct signature and names the secret that matched", async () => {
    const header = await sign(body, "s3cret");
    expect(await verifySignature(buf, header, [{ name: "IG_APP_SECRET", value: "s3cret" }])).toBe("IG_APP_SECRET");
  });

  it("falls back to the alternate secret", async () => {
    const header = await sign(body, "alt");
    const secrets = [
      { name: "IG_APP_SECRET", value: "s3cret" },
      { name: "IG_APP_SECRET_ALT", value: "alt" },
    ];
    expect(await verifySignature(buf, header, secrets)).toBe("IG_APP_SECRET_ALT");
  });

  it("rejects a wrong secret, a tampered body, and a missing/garbled header", async () => {
    const secrets = [{ name: "IG_APP_SECRET", value: "s3cret" }];
    expect(await verifySignature(buf, await sign(body, "nope"), secrets)).toBeNull();

    const tampered = new TextEncoder().encode(body + " ").buffer as ArrayBuffer;
    expect(await verifySignature(tampered, await sign(body, "s3cret"), secrets)).toBeNull();

    expect(await verifySignature(buf, null, secrets)).toBeNull();
    expect(await verifySignature(buf, "sha256=xyz", secrets)).toBeNull();
    expect(await verifySignature(buf, "sha1=" + "0".repeat(40), secrets)).toBeNull();
  });

  it("skips unset secrets", async () => {
    const header = await sign(body, "s3cret");
    const secrets = [
      { name: "IG_APP_SECRET_ALT", value: undefined },
      { name: "IG_APP_SECRET", value: "s3cret" },
    ];
    expect(await verifySignature(buf, header, secrets)).toBe("IG_APP_SECRET");
  });
});
