/*
 * Text as the scanner reads it (ADR 0174 §8), ported from Spade's `spade-classify::text`: NFKC
 * normalisation, zero-width and tag characters removed, and look-alike letters folded to the
 * ASCII letter they imitate, so a Cyrillic-c `curl` and a zero-width-split `curl` both read as
 * `curl`. What was hidden is kept as a fact of its own, since hiding a word is itself a signal.
 * Pure.
 */

/** Zero-width, bidi and tag code points that never belong in code or a name. */
const ZERO_WIDTH =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\u{E0000}-\u{E007F}]/gu;
/** Bidi overrides and embeddings, the dangerous subset that reorders text. */
const BIDI = /[\u202A-\u202E\u2066-\u2069]/u;
/** Zero-width and tag characters (bidi handled apart); an emoji ZWJ between emoji is allowed. */
const INVISIBLE = /[\u200B-\u200D\u2060-\u2064\uFEFF\u{E0000}-\u{E007F}]/u;
const TAG = /[\u{E0000}-\u{E007F}]/u;

/**
 * Look-alike letters (Cyrillic, Greek) to the Latin letter they imitate. A small, deliberate
 * table: the confusables that show up in handle and command spoofing, not every Unicode
 * confusable. Digits that imitate letters are folded by {@link skeleton}, not here.
 */
const HOMOGLYPHS: Record<string, string> = {
  // Cyrillic
  а: "a",
  в: "b",
  с: "c",
  е: "e",
  һ: "h",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  ԛ: "q",
  ѕ: "s",
  т: "t",
  и: "u",
  х: "x",
  у: "y",
  ѓ: "r",
  // Greek
  α: "a",
  β: "b",
  ϲ: "c",
  ε: "e",
  η: "n",
  ι: "i",
  κ: "k",
  ν: "v",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x",
  γ: "y",
  ρ̕: "p",
  // Latin full-width and others
  ａ: "a",
  ｅ: "e",
  ｏ: "o",
  ｃ: "c",
  ｕ: "u",
  ｒ: "r",
  ｌ: "l",
  ｓ: "s",
  ｉ: "i",
  ｎ: "n",
  ｔ: "t",
};

export interface Folded {
  /** The text NFKC-normalised, zero-width removed, look-alikes folded; case kept. */
  text: string;
  /** A letter from another script, or a full-width form, that imitates an ASCII one. */
  lookalike: boolean;
  /** A zero-width or tag character was dropped. */
  invisible: boolean;
  /** A bidirectional override or embedding is present. */
  bidi: boolean;
}

/** NFKC-fold `input`, drop zero-width and tag characters, fold look-alikes, and say what was hid. */
export function fold(input: string): Folded {
  const bidi = BIDI.test(input);
  const invisible = INVISIBLE.test(input);
  const normal = input.normalize("NFKC").replace(ZERO_WIDTH, "");
  let lookalike = false;
  let text = "";
  for (const ch of normal) {
    const latin = HOMOGLYPHS[ch] ?? HOMOGLYPHS[ch.toLowerCase()];
    if (latin !== undefined) {
      lookalike = true;
      text += ch === ch.toLowerCase() ? latin : latin.toUpperCase();
    } else {
      text += ch;
    }
  }
  return { text, lookalike, invisible, bidi };
}

/** `input` NFKC-normalised with zero-width characters removed: the text every rule reads. */
export function normaliseText(input: string): string {
  return input.normalize("NFKC").replace(ZERO_WIDTH, "");
}

/** Whether `input` holds a bidirectional control. */
export const hasBidi = (input: string): boolean => BIDI.test(input);
/** Whether `input` holds a zero-width or tag character (an emoji ZWJ between emoji is allowed). */
export function hasInvisible(input: string): boolean {
  if (TAG.test(input)) return true;
  // A ZWJ (‍) flanked by emoji presentation is a legitimate emoji sequence; any other
  // zero-width character, or a ZWJ not between emoji, counts as hidden.
  const chars = Array.from(input);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] ?? "";
    if (!INVISIBLE.test(ch)) continue;
    if (ch === "‍" && isEmoji(chars[i - 1]) && isEmoji(chars[i + 1])) continue;
    return true;
  }
  return false;
}

function isEmoji(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return /\p{Extended_Pictographic}/u.test(ch);
}

/** The script of a letter, for mixed-script detection: Latin, Cyrillic, Greek, or other. */
type Script = "latin" | "cyrillic" | "greek" | "other";
function scriptOf(ch: string): Script | undefined {
  if (/\p{Script=Latin}/u.test(ch)) return "latin";
  if (/\p{Script=Cyrillic}/u.test(ch)) return "cyrillic";
  if (/\p{Script=Greek}/u.test(ch)) return "greek";
  if (/\p{L}/u.test(ch)) return "other";
  return undefined; // not a letter
}

/**
 * A word that mixes scripts (Latin with Cyrillic or Greek in one run of letters), the classic
 * look-alike spoof. Returns the first such word, or undefined. Words are split on non-letters;
 * `other` scripts (CJK, Arabic…) never count as mixed, since they are not confusable with Latin.
 */
export function mixedScriptWord(input: string): string | undefined {
  for (const word of input.normalize("NFKC").split(/[^\p{L}]+/u)) {
    if (!word) continue;
    const scripts = new Set<Script>();
    for (const ch of word) {
      const script = scriptOf(ch);
      if (script && script !== "other") scripts.add(script);
    }
    if (scripts.has("latin") && (scripts.has("cyrillic") || scripts.has("greek"))) return word;
    if (scripts.has("cyrillic") && scripts.has("greek")) return word;
  }
  return undefined;
}

/**
 * The confusable **skeleton** of a handle or name (ADR 0174 §3, §8): lower-cased, NFKC, look-alike
 * letters and digits folded (`0→o`, `1→l`, `3→e`, `5→s`, `rn→m`, `vv→w`, `i`/`l` together), all
 * separators dropped. Two names with one skeleton can't both exist, so `ace-team` and `acc-tearn`
 * collide.
 */
export function skeleton(text: string): string {
  let s = fold(text).text.toLowerCase().normalize("NFKC");
  // Multi-letter look-alikes first, before single letters fold them apart.
  s = s.replaceAll("rn", "m").replaceAll("vv", "w").replaceAll("cl", "d").replaceAll("nn", "m");
  s = s
    .replaceAll("0", "o")
    .replaceAll("1", "l")
    .replaceAll("3", "e")
    .replaceAll("4", "a")
    .replaceAll("5", "s")
    .replaceAll("7", "t")
    .replaceAll("8", "b")
    .replaceAll("9", "g")
    .replaceAll("@", "a")
    .replaceAll("$", "s");
  // `i` and `l` are confusable with each other and with `1`; fold both to `l`.
  s = s.replaceAll("i", "l");
  // Drop everything that is not a folded lower-case letter.
  return s.replace(/[^a-z]/g, "");
}
