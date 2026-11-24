import { describe, expect, it } from "vitest";
import { matchComment, matchDm, pickPublicReply, renderDm, validateRule, type Rule, type RuleInput } from "../src/autoreply/rules";

const input = (over: Partial<RuleInput> = {}): RuleInput => ({
  name: "Christmas",
  keywords: "christmas, xmas",
  link: "https://example.com/x",
  dm: "Here you go {link}",
  publicReplies: "Sent! 📩\nDone 📩",
  anyComment: false,
  enabled: true,
  ...over,
});

const rule = (over: Partial<Rule> = {}): Rule => ({
  id: 1,
  mediaId: "1",
  name: "r",
  keywords: ["christmas"],
  link: "https://example.com",
  dm: "{link}",
  publicReplies: [],
  anyComment: false,
  enabled: true,
  ...over,
});

describe("validateRule", () => {
  it("accepts a good Reel rule and cleans the lists", () => {
    const r = validateRule(input({ keywords: " christmas ,xmas,, Christmas\nXMAS " }), true);
    expect(r).toEqual({
      ok: true,
      rule: {
        name: "Christmas",
        keywords: ["christmas", "xmas"],
        link: "https://example.com/x",
        dm: "Here you go {link}",
        publicReplies: ["Sent! 📩", "Done 📩"],
        anyComment: false,
        enabled: true,
      },
      merged: ["Christmas", "XMAS"],
    });
  });

  it("requires {link} in the DM, an https link and a name", () => {
    const r = validateRule(input({ dm: "hello", link: "http://x.com", name: " " }), true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["dm", "link", "name"]);
  });

  it("requires a keyword unless 'every comment' is on, which only Reels have", () => {
    expect(validateRule(input({ keywords: "" }), true).ok).toBe(false);
    expect(validateRule(input({ keywords: "", anyComment: true }), true).ok).toBe(true);
    expect(validateRule(input({ keywords: "", anyComment: true }), false).ok).toBe(false);
  });

  it("rejects keywords that are only emoji/punctuation", () => {
    const r = validateRule(input({ keywords: "christmas, 🎄🎄" }), true);
    expect(r.ok).toBe(false);
  });

  it("drops public replies and anyComment for DM-only rules", () => {
    const r = validateRule(input({ anyComment: true }), false);
    expect(r.ok && r.rule.publicReplies).toEqual([]);
    expect(r.ok && r.rule.anyComment).toBe(false);
  });

  it("enforces Instagram's 1000-character DM limit after the link is filled in", () => {
    const r = validateRule(input({ dm: "x".repeat(990) + "{link}", link: "https://example.com/" + "a".repeat(30) }), true);
    expect(r.ok).toBe(false);
  });
});

describe("matching", () => {
  it("anyComment matches any comment, but never a DM", () => {
    const every = rule({ anyComment: true, keywords: [] });
    expect(matchComment(every, "nice 🔥")).not.toBeNull();
    expect(matchDm([every], "nice 🔥")).toBeNull();
  });

  it("first rule wins a DM keyword tie", () => {
    const a = rule({ id: 1, keywords: ["guide"] });
    const b = rule({ id: 2, keywords: ["guide", "app"] });
    expect(matchDm([a, b], "guide pls")?.rule.id).toBe(1);
    expect(matchDm([a, b], "the APP")?.rule.id).toBe(2);
  });

  it("renders {link} everywhere and picks only from the given replies", () => {
    expect(renderDm({ dm: "{link} and {link}", link: "L" })).toBe("L and L");
    expect(pickPublicReply({ publicReplies: [] })).toBeNull();
    expect(["a", "b"]).toContain(pickPublicReply({ publicReplies: ["a", "b"] }));
  });
});

describe("keyword de-duplication", () => {
  it("merges keywords that only differ in case, accents or punctuation, and reports them", () => {
    const r = validateRule(input({ keywords: "template, TEMPLATE, Témplate!, guide" }), true);
    expect(r.ok && r.rule.keywords).toEqual(["template", "guide"]);
    expect(r.ok && r.merged).toEqual(["TEMPLATE", "Témplate!"]);
  });

  it("reports nothing when there are no duplicates", () => {
    const r = validateRule(input(), true);
    expect(r.ok && r.merged).toEqual([]);
  });
});

import { GraphError } from "../src/meta";

describe("GraphError advice", () => {
  it("turns 'messaging disabled' into the setting to change", () => {
    const e = new GraphError(400, 200, undefined, "The account owner has disabled access to Instagram Direct Messaging Outside of Instagram App.", undefined);
    expect(e.isMessagingDisabled).toBe(true);
    expect(e.advice).toContain("Allow access to messages");
  });
  it("passes other errors through", () => {
    expect(new GraphError(400, 100, undefined, "Invalid parameter", undefined).advice).toBe("Invalid parameter");
  });
});
