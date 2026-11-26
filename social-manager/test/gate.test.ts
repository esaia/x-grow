import { describe, expect, it } from "vitest";
import { linkOrFollow, sendFirstDm } from "../src/autoreply/handle";
import type { Rule } from "../src/autoreply/rules";
import { GraphError } from "../src/meta";
import type { Client, OutMessage } from "../src/networks";

const gate = { opener: "Tap below", button: "Send me the link", follow: { text: "Follow first", button: "I'm following" } };
const rule: Rule = {
  id: 4,
  mediaId: "m",
  name: "Template",
  keywords: ["template"],
  link: "https://x.test",
  dm: "Here {link}",
  publicReplies: [],
  anyComment: false,
  enabled: true,
  gate,
};

/** A client that records what it sends; `follows` / `refuseButtons` shape its answers. */
function fakeClient(opts: { follows?: boolean | Error; refuseButtons?: GraphError; noFollower?: boolean } = {}) {
  const sent: { to: string; message: OutMessage }[] = [];
  const client = {
    async privateReply(commentId: string, message: OutMessage) {
      if (opts.refuseButtons && typeof message !== "string") throw opts.refuseButtons;
      sent.push({ to: `comment:${commentId}`, message });
    },
    async sendDm(to: string, message: OutMessage) {
      sent.push({ to, message });
    },
    ...(opts.noFollower
      ? {}
      : {
          async follower() {
            if (opts.follows instanceof Error) throw opts.follows;
            return { follows: opts.follows ?? true, username: "ana" };
          },
        }),
  } as unknown as Client;
  return { client, sent };
}

describe("after a tap", () => {
  it("sends the link to a follower", async () => {
    const { client, sent } = fakeClient({ follows: true });
    expect(await linkOrFollow(client, rule, "u1", {})).toEqual({ kind: "link", username: "ana", note: undefined });
    expect(sent).toEqual([{ to: "u1", message: "Here https://x.test" }]);
  });

  it("asks someone who doesn't follow to follow first, and sends no link", async () => {
    const { client, sent } = fakeClient({ follows: false });
    expect(await linkOrFollow(client, rule, "u1", {})).toMatchObject({ kind: "follow_ask" });
    expect(sent).toEqual([
      { to: "u1", message: { text: "Follow first", buttons: [{ title: "I'm following", payload: "sm:follow:4" }] } },
    ]);
  });

  it("sends the link when the follow check fails, rather than trapping them", async () => {
    const { client, sent } = fakeClient({ follows: new GraphError(400, 100, undefined, "Unsupported get request", undefined) });
    const r = await linkOrFollow(client, rule, "u1", {});
    expect(r.kind).toBe("link");
    expect(r.note).toMatch(/Couldn't check whether they follow/);
    expect(sent).toEqual([{ to: "u1", message: "Here https://x.test" }]);
  });

  it("doesn't check at all when the rule doesn't ask for followers, or the network can't tell", async () => {
    for (const [r, opts] of [
      [{ ...rule, gate: { ...gate, follow: null } }, { follows: false }],
      [rule, { noFollower: true }],
    ] as const) {
      const { client, sent } = fakeClient(opts);
      expect((await linkOrFollow(client, r, "u1", {})).kind).toBe("link");
      expect(sent).toHaveLength(1);
    }
  });
});

describe("the comment's DM", () => {
  it("is the button when the rule has one", async () => {
    const { client, sent } = fakeClient();
    expect(await sendFirstDm(client, rule, "c1")).toEqual({ button: true });
    expect(sent[0].message).toMatchObject({ text: "Tap below" });
  });

  it("falls back to the link as text if Meta refuses the button", async () => {
    const { client, sent } = fakeClient({ refuseButtons: new GraphError(400, 100, undefined, "Invalid parameter", undefined) });
    expect(await sendFirstDm(client, rule, "c1")).toEqual({ button: false });
    expect(sent).toEqual([{ to: "comment:c1", message: "Here https://x.test" }]);
  });

  it("doesn't retry account-wide errors", async () => {
    const limit = new GraphError(400, 4, undefined, "Application request limit reached", undefined);
    const { client, sent } = fakeClient({ refuseButtons: limit });
    await expect(sendFirstDm(client, rule, "c1")).rejects.toBe(limit);
    expect(sent).toEqual([]);
  });
});
