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
