import type { AccountBadgeColor } from "@ace/protocol/accounts";

/** Account badges default to the first grapheme of the label, including CLI logins. */
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

export function accountShortLabel(account: {
  label: string;
  implicit?: boolean | undefined;
  shortLabel?: string | undefined;
}): string | undefined {
  return (
    account.shortLabel ??
    [...graphemes.segment(account.label.trim())][0]?.segment.toLocaleUpperCase()
  );
}

/** Stable palette choice; UI tokens supply the matching ink for each theme. */
export function defaultAccountBadgeColor(id: string): AccountBadgeColor {
  const palette = ["blue", "violet", "amber", "rose", "green"] as const;
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return palette[hash % palette.length] ?? "blue";
}
