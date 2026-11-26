import { describe, expect, it } from "vitest";
import { BUILT_IN, ruleDefaults, validateDefaults } from "../src/autoreply/defaults";
import type { Env } from "../src/env";

/** An env whose settings table holds `value` (or nothing). */
const envWith = (value: string | null) =>
  ({
    DB: { prepare: () => ({ bind: () => ({ first: async () => (value === null ? null : { value }) }) }) },
  }) as unknown as Env;

describe("rule defaults", () => {
  it("are the built-in texts until saved", async () => {
    expect(await ruleDefaults(envWith(null))).toEqual(BUILT_IN);
  });

  it("lay saved texts over the built-in ones, ignoring unknown or mistyped fields", async () => {
    const saved = JSON.stringify({ dm: "Yours: {link}", buttonFirst: true, button: 5, admin: "x" });
    expect(await ruleDefaults(envWith(saved))).toEqual({ ...BUILT_IN, dm: "Yours: {link}", buttonFirst: true });
    expect(await ruleDefaults(envWith("not json"))).toEqual(BUILT_IN);
  });

  it("are checked like an auto-reply, but the link may stay empty", () => {
    expect(validateDefaults(BUILT_IN)).toEqual({});
    expect(Object.keys(validateDefaults({ ...BUILT_IN, dm: "no link here", link: "http://insecure" })).sort()).toEqual([
      "dm",
      "link",
    ]);
    expect(validateDefaults({ ...BUILT_IN, buttonFirst: true, button: "x".repeat(21) })).toHaveProperty("button");
  });
});
