const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

export const accountBadgeStyle =
  "inline-flex h-3.5 min-w-3.5 shrink-0 items-center justify-center rounded-sm bg-(--account-color)/14 px-0.5 text-2xs leading-none font-medium text-(--account-color)";

/** Bound legacy badges without splitting emoji; unconfigured accounts use name initials. */
export function accountBadge(label: string, shortLabel?: string | null): string {
  const value = shortLabel?.trim();
  if (value)
    return [...graphemes.segment(value)]
      .slice(0, 2)
      .map((part) => part.segment)
      .join("");
  return (
    label
      .trim()
      .split(/\s+/u)
      .slice(0, 2)
      .map((word) => [...graphemes.segment(word)][0]?.segment.toLocaleUpperCase() ?? "")
      .join("") || "?"
  );
}
