/** Pure fuzzy-matching primitives for the path index. */

/**
 * Two 30-bit character-class masks, small integers on every V8 build. Letters
 * fill the first; digits, common separators and hashed other characters fill
 * the second. A query can match a path only if the path's masks contain all of
 * the query's bits, so completion skips most non-matching paths cheaply.
 */
export interface CharacterMask {
  readonly letters: number;
  readonly others: number;
}
const separators = ".-_/ ";
export function characterMask(lower: string): CharacterMask {
  let letters = 0,
    others = 0;
  for (let at = 0; at < lower.length; at++) {
    const code = lower.charCodeAt(at);
    if (code >= 97 && code <= 122) letters |= 1 << (code - 97);
    else if (code >= 48 && code <= 57) others |= 1 << (code - 48);
    else {
      const separator = separators.indexOf(lower[at] ?? "");
      others |= 1 << (separator >= 0 ? 10 + separator : 15 + (code % 15));
    }
  }
  return { letters, others };
}
export function containsMask(path: CharacterMask, query: CharacterMask): boolean {
  return (
    (path.letters & query.letters) === query.letters &&
    (path.others & query.others) === query.others
  );
}

/** Lower is better; -1 when the needle is not a subsequence of the path. */
export function scoreSubsequence(lower: string, needle: string): number {
  let at = 0,
    score = lower.length;
  for (const char of needle) {
    const next = lower.indexOf(char, at);
    if (next < 0) return -1;
    score += (next - at) * 4;
    at = next + 1;
  }
  return score;
}

/**
 * Retained heap for one indexed path: the path and its lowercase copy (two
 * bytes per UTF-16 unit, conservatively), plus the Map, Set and entry records
 * that hold it. Calibrated against `bench/index-resources.ts`.
 */
export function entryBytes(path: string): number {
  return 4 * path.length + 160;
}
