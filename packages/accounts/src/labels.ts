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
