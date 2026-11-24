import { describe, expect, it } from "vitest";
import { allowedTypos, editDistance, matchKeywords, normalize } from "../src/autoreply/match";

const XMAS = ["christmas", "xmas"];

describe("normalize", () => {
  it("lowercases, strips punctuation and emoji, splits words", () => {
    expect(normalize("Christmas!! please 🎄🎄")).toEqual(["christmas", "please"]);
  });
  it("folds accents", () => {
    expect(normalize("Navidád, CAFÉ")).toEqual(["navidad", "cafe"]);
  });
  it("keeps non-Latin letters and digits", () => {
    expect(normalize("შობა 2026!")).toEqual(["შობა", "2026"]);
  });
  it("treats emoji glued to a word as a separator", () => {
    expect(normalize("🎄christmas🎅pls")).toEqual(["christmas", "pls"]);
  });
  it("returns nothing for emoji-only text", () => {
    expect(normalize("🎄🎅 ❤️")).toEqual([]);
  });
});

describe("allowedTypos", () => {
  it.each([
    [1, 0], [3, 0],
    [4, 1], [7, 1],
    [8, 2], [9, 2], [20, 2],
  ])("length %i → %i typos", (len, typos) => {
    expect(allowedTypos(len)).toBe(typos);
  });
});

describe("editDistance", () => {
  it("counts insertions, deletions, substitutions", () => {
    expect(editDistance("chrisstmas", "christmas")).toBe(1);
    expect(editDistance("chrismas", "christmas")).toBe(1);
    expect(editDistance("khristmas", "christmas")).toBe(1);
  });
  it("counts an adjacent swap as one edit", () => {
    expect(editDistance("chrsitmas", "christmas")).toBe(1);
  });
  it("exits early past the bound", () => {
    expect(editDistance("hello", "christmas", 2)).toBe(3);
  });
});

describe("matchKeywords", () => {
  it.each([
    "christmas",
    "Christmas!!",
    "CHRISTMAS",
    "christmas please 🎄",
    "chrisstmas",
    "chrismas pls",
    "chrsitmas", // swapped letters
    "chrsitmass", // swap + extra letter = 2 typos, allowed at 9 letters
    "I want the christmas link!",
    "xmas",
    "Xmas 🎄",
    "xmass", // 1 typo on a 4-letter keyword
    "x mas", // split word
    "christ mas", // split word
  ])("matches %j", (text) => {
    expect(matchKeywords(text, XMAS)).not.toBeNull();
  });

  it.each([
    "",
    "🎄🎄🎄",
    "love this!",
    "merry",
    "chrstm", // 3 typos on a 9-letter keyword
    "xxmass", // 2 typos on a 4-letter keyword
    "the max", // "max" is 2 edits from "xmas"
  ])("does not match %j", (text) => {
    expect(matchKeywords(text, XMAS)).toBeNull();
  });

  // The 1-typo rule for 4–7 letters is what the spec asks for, and these
  // are its price: pick keywords that are not one letter from a common word.
  it("documents the false positives of short keywords", () => {
    expect(matchKeywords("mas", ["xmas"])).not.toBeNull();
    expect(matchKeywords("nice line", ["link"])).not.toBeNull();
    expect(matchKeywords("pink!", ["link"])).not.toBeNull();
  });

  it("3-letter keywords must match exactly", () => {
    expect(matchKeywords("gift", ["gif"])).toBeNull();
    expect(matchKeywords("gif please", ["gif"])).not.toBeNull();
  });

  it("8+ letter keywords allow 2 typos but not 3", () => {
    expect(matchKeywords("chrstmss", ["christmas"])?.distance).toBe(2);
    expect(matchKeywords("chrtms", ["christmas"])).toBeNull();
  });

  it("reports which keyword and word matched", () => {
    expect(matchKeywords("Merry XMAS!!", XMAS)).toEqual({ keyword: "xmas", matched: "xmas", distance: 0 });
    expect(matchKeywords("chrisstmas 🎄", XMAS)).toEqual({ keyword: "christmas", matched: "chrisstmas", distance: 1 });
  });

  it("matches multi-word keywords, split or merged", () => {
    const kw = ["silent night"];
    expect(matchKeywords("Silent Night please", kw)).not.toBeNull();
    expect(matchKeywords("silentnight", kw)).not.toBeNull();
    expect(matchKeywords("silent nigth", kw)).not.toBeNull();
    expect(matchKeywords("silent", kw)).toBeNull();
  });

  it("matches accented and non-Latin keywords", () => {
    expect(matchKeywords("NAVIDAD!", ["navidád"])).not.toBeNull();
    expect(matchKeywords("შობა 🎄", ["შობა"])).not.toBeNull();
  });

  it("ignores empty keywords", () => {
    expect(matchKeywords("christmas", ["", "🎄"])).toBeNull();
  });
});
