/**
 * Auto-reply rules: types, validation of what the admin panel submits, and
 * matching. Pure functions; storage lives with each network (e.g.
 * instagram/db.ts), so this works for any network.
 */
import type { OutMessage } from "../networks";
import { matchKeywords, normalize, type KeywordHit } from "./match";

/**
 * "Tap a button first": the comment's DM is `opener` with one button, and the
 * link comes when they tap it. Tapping opens the conversation, so we may send
 * more than the one private reply, and (Instagram) ask Meta whether they
 * follow the account. `follow` set → people who don't follow get `follow.text`
 * with a button to tap once they do.
 */
export interface Gate {
  opener: string;
  button: string;
  follow: { text: string; button: string } | null;
}

export interface Rule {
  id: number;
  /** The Reel/post this rule answers comments on; null → DM-only keyword. */
  mediaId: string | null;
  name: string;
  keywords: string[];
  link: string;
  /** DM / private-reply text. `{link}` is replaced with `link`. */
  dm: string;
  /** Public replies under the comment; one is picked at random. Empty → none. */
  publicReplies: string[];
  /** true → every comment on the Reel gets the DM, keyword or not. */
  anyComment: boolean;
  enabled: boolean;
  /** null → the comment's DM is the link itself. */
  gate: Gate | null;
}

/** What a form submits, before validation. */
export interface RuleInput {
  name: string;
  keywords: string;
  link: string;
  dm: string;
  publicReplies: string;
  anyComment: boolean;
  enabled: boolean;
  /** "Ask them to tap a button first". */
  buttonFirst: boolean;
  opener: string;
  button: string;
  /** "Only send the link to followers". */
  followFirst: boolean;
  followText: string;
  followButton: string;
}

export type RuleFields = Omit<Rule, "id" | "mediaId">;

export const LIMITS = {
  name: 80,
  keyword: 50,
  keywords: 20,
  link: 500,
  /** Instagram's message limit is 1000 characters. */
  dm: 1000,
  publicReply: 300,
  publicReplies: 10,
  /** Meta's button template: text up to 640 characters, button titles up to 20. */
  opener: 640,
  button: 20,
};

/**
 * Turns form input into a rule, or field → message errors. `isReel` turns
 * on the comment-only fields (any comment, public replies); `buttons` (the
 * network supports a button first) the gate.
 */
export function validateRule(
  input: RuleInput,
  isReel: boolean,
  buttons = false,
):
  | { ok: true; rule: RuleFields; merged: string[] }
  | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  const name = input.name.trim();
  if (!name) errors.name = "Give it a name, so you can recognise it in the activity list.";
  else if (name.length > LIMITS.name) errors.name = `At most ${LIMITS.name} characters.`;

  const anyComment = isReel && input.anyComment;
  // Matching ignores case, accents and punctuation, so "TEMPLATE" next to
  // "template" adds nothing. Merge them, and say so (`merged`).
  const { items: keywords, dropped: merged } = splitList(input.keywords, /[,\n]/, (k) => normalize(k).join(" "));
  const empty = keywords.filter((k) => normalize(k).length === 0);
  if (empty.length) errors.keywords = `These have no letters or digits left after cleanup: ${empty.join(" ")}`;
  else if (keywords.some((k) => k.length > LIMITS.keyword)) errors.keywords = `Each keyword: at most ${LIMITS.keyword} characters.`;
  else if (keywords.length > LIMITS.keywords) errors.keywords = `At most ${LIMITS.keywords} keywords.`;
  else if (keywords.length === 0 && !anyComment)
    errors.keywords = isReel ? 'Add a keyword, or tick "Reply to every comment".' : "Add at least one keyword.";

  const link = input.link.trim();
  if (!link) errors.link = "Add the link to send.";
  else if (link.length > LIMITS.link) errors.link = `At most ${LIMITS.link} characters.`;
  else if (!isHttpsUrl(link)) errors.link = "Use a full https:// link.";

  const dm = input.dm.trim();
  if (!dm) errors.dm = "Write the message to send.";
  else if (!dm.includes("{link}")) errors.dm = "Put {link} where the link should go.";
  else if (renderLength(dm, link) > LIMITS.dm)
    errors.dm = `With the link filled in this is over Instagram's ${LIMITS.dm}-character limit.`;

  const publicReplies = isReel ? splitList(input.publicReplies, /\n/).items : [];
  if (publicReplies.length > LIMITS.publicReplies) errors.publicReplies = `At most ${LIMITS.publicReplies} replies.`;
  else if (publicReplies.some((r) => r.length > LIMITS.publicReply))
    errors.publicReplies = `Each reply: at most ${LIMITS.publicReply} characters.`;

  let gate: Gate | null = null;
  if (isReel && buttons && input.buttonFirst) {
    const opener = input.opener.trim();
    const button = input.button.trim();
    if (!opener) errors.opener = "Write the message that comes with the button.";
    else if (opener.length > LIMITS.opener) errors.opener = `At most ${LIMITS.opener} characters.`;
    if (!button) errors.button = "Give the button a label.";
    else if (button.length > LIMITS.button) errors.button = `At most ${LIMITS.button} characters: Instagram cuts longer labels.`;

    let follow: Gate["follow"] = null;
    if (input.followFirst) {
      const text = input.followText.trim();
      const label = input.followButton.trim();
      if (!text) errors.followText = "Write what people who don't follow you yet get.";
      else if (text.length > LIMITS.opener) errors.followText = `At most ${LIMITS.opener} characters.`;
      if (!label) errors.followButton = "Give the button a label.";
      else if (label.length > LIMITS.button) errors.followButton = `At most ${LIMITS.button} characters: Instagram cuts longer labels.`;
      follow = { text, button: label };
    }
    gate = { opener, button, follow };
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    rule: { name, keywords, link, dm, publicReplies, anyComment, enabled: input.enabled, gate },
    merged,
  };
}

/**
 * Trimmed, non-empty, de-duplicated items in order. Two items are the same
 * when `key` says so (default: case-insensitive); later copies are dropped.
 */
function splitList(
  text: string,
  separator: RegExp,
  key: (item: string) => string = (item) => item.toLowerCase(),
): { items: string[]; dropped: string[] } {
  const seen = new Set<string>();
  const items: string[] = [];
  const dropped: string[] = [];
  for (const raw of text.split(separator)) {
    const item = raw.trim();
    if (!item) continue;
    const k = key(item);
    if (seen.has(k)) {
      dropped.push(item);
      continue;
    }
    seen.add(k);
    items.push(item);
  }
  return { items, dropped };
}

function isHttpsUrl(s: string): boolean {
  try {
    return new URL(s).protocol === "https:";
  } catch {
    return false;
  }
}

function renderLength(dm: string, link: string): number {
  return dm.replaceAll("{link}", link).length;
}

export function renderDm(rule: Pick<Rule, "dm" | "link">): string {
  return rule.dm.replaceAll("{link}", rule.link);
}

// ── Buttons ────────────────────────────────────────────────────────────────

/** What a button sends back when tapped: which step, of which rule. */
export type Postback = { step: "open" | "follow"; ruleId: number };

export const postbackPayload = (p: Postback) => `sm:${p.step}:${p.ruleId}`;

export function parsePostback(payload: string | undefined): Postback | null {
  const m = payload?.match(/^sm:(open|follow):(\d+)$/);
  return m ? { step: m[1] as Postback["step"], ruleId: Number(m[2]) } : null;
}

/** The comment's DM: the link, or the opener with its button. */
export function firstMessage(rule: Pick<Rule, "id" | "dm" | "link" | "gate">): OutMessage {
  if (!rule.gate) return renderDm(rule);
  return {
    text: rule.gate.opener,
    buttons: [{ title: rule.gate.button, payload: postbackPayload({ step: "open", ruleId: rule.id }) }],
  };
}

/** For someone who tapped but doesn't follow yet. Null when the rule doesn't ask. */
export function followMessage(rule: Pick<Rule, "id" | "gate">): OutMessage | null {
  const follow = rule.gate?.follow;
  if (!follow) return null;
  return {
    text: follow.text,
    buttons: [{ title: follow.button, payload: postbackPayload({ step: "follow", ruleId: rule.id }) }],
  };
}

export function pickPublicReply(rule: Pick<Rule, "publicReplies">): string | null {
  const options = rule.publicReplies;
  return options.length ? options[Math.floor(Math.random() * options.length)] : null;
}

/** Does this comment trigger the rule? `anyComment` rules match everything. */
export function matchComment(rule: Rule, text: string): KeywordHit | null {
  if (rule.anyComment) return { keyword: "*any comment*", matched: "", distance: 0 };
  return matchKeywords(text, rule.keywords);
}

/**
 * First rule, in the given order, whose keywords appear in a DM. Callers
 * pass the account's enabled rules oldest first, so the rule you set up
 * first wins a tie. `anyComment` is ignored: "every comment" must not mean
 * "every DM".
 */
export function matchDm(rules: Rule[], text: string): { rule: Rule; hit: KeywordHit } | null {
  for (const rule of rules) {
    const hit = matchKeywords(text, rule.keywords);
    if (hit) return { rule, hit };
  }
  return null;
}
