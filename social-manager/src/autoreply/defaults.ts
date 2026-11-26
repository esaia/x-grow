/**
 * What a new auto-reply starts with: the link, DM, public replies and the
 * "Button first" texts. Built in below; owners change them on the Settings
 * page (settings.rule_defaults). Only new auto-replies use them: saved ones
 * keep their own texts.
 */
import type { Env } from "../env";
import { validateRule, type RuleInput } from "./rules";

export type RuleDefaults = Omit<RuleInput, "name" | "keywords" | "anyComment" | "enabled">;

export const BUILT_IN: RuleDefaults = {
  link: "",
  dm: "Here's the link you asked for 👇\n{link}",
  // Short and varied, so a busy Reel's replies don't read like a bot.
  publicReplies: [
    "Just sent it to your DMs 🙌",
    "Check your inbox 👀",
    "Sent you a DM!",
    "It's in your messages ✨",
    "DM'd you! If you can't see it, check message requests",
  ].join("\n"),
  buttonFirst: false,
  opener: "Hey! Tap below and I'll send you the link 👇",
  button: "Send me the link",
  followFirst: false,
  followText: "Looks like you're not following me yet 👀 Follow, then tap below and the link is yours.",
  followButton: "I'm following",
};

const KEY = "rule_defaults";

/** Saved defaults over the built-in ones, so a field added later still has a value. */
export async function ruleDefaults(env: Env): Promise<RuleDefaults> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(KEY).first<{ value: string }>();
  if (!row) return { ...BUILT_IN };
  try {
    return { ...BUILT_IN, ...pick(JSON.parse(row.value)) };
  } catch {
    return { ...BUILT_IN };
  }
}

export async function saveRuleDefaults(env: Env, d: RuleDefaults, by: string) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  )
    .bind(KEY, JSON.stringify(d), new Date().toISOString(), by)
    .run();
}

/** Only the known fields, with the right types: the JSON is ours, but be strict anyway. */
function pick(raw: unknown): Partial<RuleDefaults> {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Partial<RuleDefaults> = {};
  for (const k of Object.keys(BUILT_IN) as (keyof RuleDefaults)[]) {
    const v = o[k];
    if (typeof v === typeof BUILT_IN[k]) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * Checks defaults with the same rules as an auto-reply, so a new one never
 * starts out invalid. The link may stay empty (each post usually has its own).
 */
export function validateDefaults(d: RuleDefaults): Record<string, string> {
  const result = validateRule(
    { ...d, name: "Defaults", keywords: "x", anyComment: false, enabled: true, link: d.link.trim() || "https://example.com" },
    true,
    true,
  );
  return result.ok ? {} : result.errors;
}
