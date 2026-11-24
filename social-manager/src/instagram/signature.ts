/**
 * Verifies Meta's `X-Hub-Signature-256: sha256=<hex>` header: an HMAC-SHA256
 * of the *raw* request bytes. Parse JSON only after this passes — re-serialising
 * a parsed body changes the bytes and the HMAC with them.
 *
 * Uses `crypto.subtle.verify`, which compares in constant time, instead of
 * computing a hex digest and comparing strings.
 */
export async function verifySignature(
  body: ArrayBuffer,
  header: string | null,
  secrets: { name: string; value: string | undefined }[],
): Promise<string | null> {
  const signature = parseHeader(header);
  if (!signature) return null;

  for (const { name, value } of secrets) {
    if (!value) continue;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(value),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    if (await crypto.subtle.verify("HMAC", key, signature, body)) return name;
  }
  return null;
}

function parseHeader(header: string | null): Uint8Array<ArrayBuffer> | null {
  const match = header?.trim().match(/^sha256=([0-9a-fA-F]{64})$/);
  if (!match) return null;
  const hex = match[1];
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** Hex HMAC-SHA256, used by tests (the local test script has its own copy). */
export async function sign(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
