/**
 * Typo-tolerant keyword matching. Pure functions, no Worker APIs, so the
 * tests run them directly.
 *
 *   "Christmas!!"            → christmas   (punctuation)
 *   "chrisstmas please 🎄"   → christmas   (1 typo, emoji, extra words)
 *   "chrsitmas"              → christmas   (a swap counts as 1 typo)
 *   "x mas"                  → xmas        (a split word is re-joined)
 */

export interface KeywordHit {
  /** The keyword as written in keywords.ts. */
  keyword: string;
  /** The (normalised) text in the comment that matched it. */
  matched: string;
  /** Edit distance between the two; 0 is an exact match. */
  distance: number;
}

/**
 * Lowercase, strip accents, drop emoji and punctuation, split into words.
 * `\p{L}\p{N}` keeps letters and digits in every script, so Georgian,
 * Cyrillic etc. survive. Only Latin-style accents are folded away.
 */
export function normalize(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "") // combining marks: é → e
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** Typos allowed for a keyword of `length` letters. */
export function allowedTypos(length: number): number {
  if (length <= 3) return 0;
  if (length <= 7) return 1;
  return 2;
}

/**
 * Optimal-string-alignment distance: Levenshtein plus "two adjacent letters
 * swapped" as a single edit, which is the most common phone typo. Returns
 * `max + 1` as soon as the answer must exceed `max`, so a long non-matching
 * word costs almost nothing.
 */
export function editDistance(a: string, b: string, max = Infinity): number {
  const s = Array.from(a);
  const t = Array.from(b);
  if (Math.abs(s.length - t.length) > max) return max + 1;
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;

  let prevPrev = new Array<number>(t.length + 1).fill(0);
  let prev = Array.from({ length: t.length + 1 }, (_, j) => j);
  let curr = new Array<number>(t.length + 1).fill(0);

  for (let i = 1; i <= s.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
        v = Math.min(v, prevPrev[j - 2] + 1);
      }
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    [prevPrev, prev, curr] = [prev, curr, prevPrev];
  }
  return prev[t.length];
}

/**
 * First keyword (in list order) that appears in `text`, or null.
 *
 * A keyword of N words is compared against every run of N-1, N and N+1
 * adjacent comment words, joined without spaces, so "x mas" finds "xmas" and
 * "silentnight" finds "silent night". Tolerance comes from the keyword's
 * letter count (spaces excluded).
 */
export function matchKeywords(text: string, keywords: readonly string[]): KeywordHit | null {
  const words = normalize(text);
  if (words.length === 0) return null;

  for (const keyword of keywords) {
    const kwWords = normalize(keyword);
    if (kwWords.length === 0) continue;
    const target = kwWords.join("");
    const max = allowedTypos(Array.from(target).length);

    for (let size = Math.max(1, kwWords.length - 1); size <= kwWords.length + 1; size++) {
      for (let start = 0; start + size <= words.length; start++) {
        const candidate = words.slice(start, start + size).join("");
        const distance = editDistance(candidate, target, max);
        if (distance <= max) return { keyword, matched: candidate, distance };
      }
    }
  }
  return null;
}
