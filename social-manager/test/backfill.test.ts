import { describe, expect, it } from "vitest";
import { classifyComments } from "../src/autoreply/backfill";
import type { NetComment } from "../src/networks";

const now = Date.parse("2026-11-24T12:00:00Z");
const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString();
const account = { id: "999", username: "llamapresenter" };
const rule = {
  id: 1,
  mediaId: "m1",
  name: "Template",
  keywords: ["template"],
  anyComment: false,
  enabled: true,
  link: "https://x",
  dm: "{link}",
  publicReplies: [],
};
const c = (id: string, user: string, text: string, days: number, replies: NetComment[] = []): NetComment => ({
  id,
  text,
  timestamp: daysAgo(days),
  userId: `u-${user}`,
  username: user,
  replies,
});

describe("classifyComments (past comments)", () => {
  it("picks matching comments within 7 days, one per person, newest first", () => {
    const r = classifyComments(
      [
        c("1", "ana", "TEMPLATE pls", 1),
        c("2", "ana", "template again", 0.5),
        c("3", "bob", "templte!", 3),
        c("4", "cat", "nice video", 2),
        c("5", "dan", "template", 8),
      ],
      rule,
      account,
      new Set(),
      now,
    );
    expect(r.eligible.map((e) => [e.commentId, e.username])).toEqual([
      ["1", "ana"], // ana's first matching comment, not her second
      ["3", "bob"],
    ]);
    expect(r).toMatchObject({ alreadySent: 1, noMatch: 1, tooOld: 1, own: 0 });
  });

  it("skips people who already got the DM, and the account's own comments and replies", () => {
    const r = classifyComments(
      [c("1", "ana", "template", 1, [c("1r", "llamapresenter", "template sent!", 0.9)]), c("2", "bob", "template", 1)],
      rule,
      account,
      new Set(["u-ana"]),
      now,
    );
    expect(r.eligible.map((e) => e.username)).toEqual(["bob"]);
    expect(r).toMatchObject({ alreadySent: 1, own: 1 });
  });

  it("includes matching replies from other people", () => {
    const r = classifyComments([c("1", "ana", "hi", 1, [c("1r", "eve", "template?", 0.5)])], rule, account, new Set(), now);
    expect(r.eligible.map((e) => e.commentId)).toEqual(["1r"]);
  });

  it("falls back to the comment id when a Facebook comment has no commenter", () => {
    const anon: NetComment = { id: "c9", text: "template", timestamp: daysAgo(1) };
    const r = classifyComments([anon], rule, account, new Set(), now);
    expect(r.eligible.map((e) => e.userId)).toEqual(["comment:c9"]);
  });

  it("respects 'every comment' rules", () => {
    const r = classifyComments([c("1", "ana", "🔥", 1)], { ...rule, anyComment: true, keywords: [] }, account, new Set(), now);
    expect(r.eligible).toHaveLength(1);
  });
});
