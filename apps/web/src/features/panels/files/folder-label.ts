/*
 * How a folder shows beside a file name in a narrow row (Open editors, the explorer's filter and
 * search rows). Pure: the room and a measure in, the label out. The nearest folders are the
 * useful part, so the label gives way from its start.
 */

/** The fewest letters of the nearest folder worth showing; fewer reads as noise. */
export const leastLetters = 4;

/**
 * The longest readable form of `folder` that fits `room` (in the units `measure` returns):
 * the whole folder; then with whole leading folders dropped ("ui-core/src"); then "…/" and the
 * nearest folder; then that folder's name cut at its end ("…/works…"). With no room for
 * `leastLetters` of the nearest folder, nothing. A root file's folder ("") is nothing.
 */
export function folderLabel(
  folder: string,
  room: number,
  measure: (text: string) => number,
): string {
  if (folder === "") return "";
  const parts = folder.split("/");
  const nearest = parts.at(-1) ?? folder;
  const fits = (text: string) => measure(text) <= room;
  // Leading folders drop whole down to the last two; the nearest alone is marked with "…/".
  const lastDrop = Math.max(0, parts.length - 2);
  for (let first = 0; first <= lastDrop; first += 1) {
    const form = parts.slice(first).join("/");
    if (fits(form)) return form;
  }
  const lead = parts.length > 1 ? "…/" : "";
  if (lead && fits(`${lead}${nearest}`)) return `${lead}${nearest}`;
  const letters = [...nearest];
  for (let kept = letters.length - 1; kept >= leastLetters; kept -= 1) {
    const form = `${lead}${letters.slice(0, kept).join("")}…`;
    if (fits(form)) return form;
  }
  return "";
}
