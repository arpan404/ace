/*
 * A tree row's name cut at its end when the row is too narrow (owner, 2026-11-21: "adapter-ac…",
 * not "ad… er-acp"). Pure: the name and what it names in, the part that gives way and the part
 * that always shows out. The row's tooltip keeps the whole path.
 */

/** Longer than this after the last dot, it is part of the name, not an extension. */
const longestExtension = 8;

/**
 * Where a name's end cut goes: a folder's whole name gives way (`head`); a file keeps its
 * extension (`end`, ".ts") so the type still reads after the cut.
 */
export function endCut(name: string, kind: "file" | "folder"): { head: string; end: string } {
  if (kind === "folder") return { head: name, end: "" };
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot) : "";
  if (extension.length < 2 || extension.length > longestExtension + 1)
    return { head: name, end: "" };
  return { head: name.slice(0, dot), end: extension };
}

/** How far past its room a name may measure and still show whole: rounding, not a real overflow. */
const roundingSlack = 0.5;
const ellipsis = "…";

/**
 * The label a tree row shows for `name` in `room` pixels, `measure` giving a text's width in the
 * row's own font. A name that fits shows whole; past its room it loses letters from the end of
 * its head behind one "…", keeping its extension (`endCut`); with no room for a letter before
 * the extension, it is cut at its end instead.
 */
export function endLabel(
  name: string,
  kind: "file" | "folder",
  room: number,
  measure: (text: string) => number,
): string {
  if (measure(name) <= room + roundingSlack) return name;
  const { head, end } = endCut(name, kind);
  const kept = longestFit(head, end, room, measure);
  if (kept > 0 || !end) return head.slice(0, kept) + ellipsis + end;
  return name.slice(0, longestFit(name, "", room, measure)) + ellipsis;
}

/** How many of `head`'s first letters fit before "…" and `end` in `room`. */
function longestFit(
  head: string,
  end: string,
  room: number,
  measure: (text: string) => number,
): number {
  let low = 0;
  let high = head.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure(head.slice(0, mid) + ellipsis + end) <= room + roundingSlack) low = mid;
    else high = mid - 1;
  }
  return low;
}
