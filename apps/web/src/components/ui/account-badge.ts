import { accountShortLabel } from "@ace/ui-core";
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Bound legacy badges without splitting emoji; unconfigured accounts use name initials. */
export function accountBadge(label: string, shortLabel?: string | null): string {
  const value = shortLabel?.trim();
  if (value)
    return [...graphemes.segment(value)]
      .slice(0, 2)
      .map((part) => part.segment)
      .join("");
  return accountShortLabel({ label }) ?? "?";
}
