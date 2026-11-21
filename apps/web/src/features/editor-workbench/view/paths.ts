/** The last segment of a checkout path: what a tab shows. */
export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The folder part of a checkout path ("" at the checkout's root). */
export function folderOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

/**
 * A folder split for middle truncation: `head` may give way (it truncates), `tail` (the nearest
 * folder) always shows. Until #2519's `MiddleText` (panels/files/middle-name.tsx) is on main;
 * then Open editors should use it and this can go.
 */
export function folderEnds(folder: string): { head: string; tail: string } {
  const at = folder.lastIndexOf("/");
  return at === -1
    ? { head: "", tail: folder }
    : { head: folder.slice(0, at + 1), tail: folder.slice(at + 1) };
}
