import { accountShortLabel } from "@ace/ui-core";
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

export const accountBadgeStyle =
  "inline-flex h-3.5 min-w-3.5 shrink-0 items-center justify-center rounded-sm bg-[color-mix(in_srgb,var(--account-color)_20%,var(--background))] px-0.5 text-2xs leading-none font-medium text-(--account-color)";
export const accountBadgeOverlayStyle = `${accountBadgeStyle} absolute right-0 bottom-0 origin-bottom-right scale-75 rounded-full ring-1 ring-background`;

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
