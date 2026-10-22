import { accountShortLabel } from "@ace/accounts/labels";
/** Emoji and flags: badges draw pictures from the curated icon set, never as text. */
const pictographic = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

/**
 * Up to two letters for an account's badge. A stored emoji badge from before the curated icon set
 * is dropped for the name's initial; unconfigured accounts use it too.
 */
export function accountBadge(label: string, shortLabel?: string | null): string {
  const value = shortLabel?.trim();
  if (value && !pictographic.test(value))
    // Made per call: native bridges load this module where Intl may arrive late.
    return [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(value)]
      .slice(0, 2)
      .map((part) => part.segment)
      .join("");
  return accountShortLabel({ label }) ?? "?";
}
