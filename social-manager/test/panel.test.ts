import { describe, expect, it } from "vitest";
import { firstLine, newestFirst } from "../src/autoreply/panel";

describe("default auto-reply name", () => {
  it("cuts a long first line at a whole word", () => {
    expect(firstLine("Still designing service slides from scratch every Sunday? 😩")).toBe(
      "Still designing service slides from",
    );
  });
  it("keeps a short first line and skips blank lines", () => {
    expect(firstLine("\n\nComment APP 🚀\nmore")).toBe("Comment APP 🚀");
  });
});

describe("auto-reply order", () => {
  const rule = (name: string, mediaId: string | null, createdAt: string) => ({ name, mediaId, createdAt });
  it("puts the newest post first, then posts off this page, then DM keywords", () => {
    const media = new Map([
      ["old", { timestamp: "2026-11-01T10:00:00+0000" }],
      ["new", { timestamp: "2026-11-20T10:00:00+0000" }],
      ["mid", { timestamp: "2026-11-10T10:00:00+0000" }],
    ]);
    const rules = [
      rule("dm", null, "2026-11-25T00:00:00Z"),
      rule("old", "old", "2026-11-24T00:00:00Z"),
      rule("unseen-a", "x", "2026-11-02T00:00:00Z"),
      rule("new", "new", "2026-11-21T00:00:00Z"),
      rule("unseen-b", "y", "2026-11-05T00:00:00Z"),
      rule("mid", "mid", "2026-11-11T00:00:00Z"),
    ];
    expect(newestFirst(rules, media).map((r) => r.name)).toEqual(["new", "mid", "old", "unseen-b", "unseen-a", "dm"]);
  });
});
