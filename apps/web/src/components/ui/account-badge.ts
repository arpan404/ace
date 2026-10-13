import { accountShortLabel } from "@ace/ui-core";
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
/** Emoji and flags: badges draw pictures from the curated icon set, never as text. */
const pictographic = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

/**
 * Up to two letters for an account's badge. A stored emoji badge from before the curated icon set
 * is dropped for the name's initial; unconfigured accounts use it too.
 */
export function accountBadge(label: string, shortLabel?: string | null): string {
  const value = shortLabel?.trim();
  if (value && !pictographic.test(value))
    return [...graphemes.segment(value)]
      .slice(0, 2)
      .map((part) => part.segment)
      .join("");
  return accountShortLabel({ label }) ?? "?";
}
