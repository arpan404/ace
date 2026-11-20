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
 * Each path's tab name, and for names shared in one strip the nearest folder that tells them
 * apart (spec 20: "index.ts · panels"). Paths with a unique name get no hint.
 */
export function tabHints(paths: readonly string[]): Map<string, string | undefined> {
  const byName = new Map<string, string[]>();
  for (const path of paths) {
    const name = fileName(path);
    byName.set(name, [...(byName.get(name) ?? []), path]);
  }
  const hints = new Map<string, string | undefined>();
  for (const same of byName.values()) {
    for (const path of same)
      hints.set(path, same.length > 1 ? nearestDifference(path, same) : undefined);
  }
  return hints;
}

function nearestDifference(path: string, same: readonly string[]): string {
  const folders = folderOf(path).split("/").filter(Boolean);
  const others = same.filter((other) => other !== path).map((other) => folderOf(other).split("/"));
  // Walk up from the nearest folder until one differs from every other path's folder there.
  for (let depth = 1; depth <= folders.length; depth++) {
    const mine = folders[folders.length - depth];
    if (others.every((other) => other[other.length - depth] !== mine)) return mine ?? "";
  }
  return folders.at(-1) ?? "/";
}
