/**
 * Lexical route of a symlink stored at `path` (relative to the folder root) with `target`.
 * Returns the folder-relative directories the target passes through before its last
 * component, or undefined when the target is absolute or climbs above the root.
 *
 * Lexical resolution is only sound when none of those directories is itself a link,
 * so callers must reject the link when any returned path is a symlink.
 */
export function linkRoute(path: string, target: string): string[] | undefined {
  if (!target || target.includes("\0") || target.startsWith("/")) return undefined;
  const current = path.split("/").slice(0, -1);
  const parts = target.split("/");
  const through: string[] = [];
  for (const [index, part] of parts.entries()) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!current.length) return undefined;
      current.pop();
      continue;
    }
    current.push(part);
    if (parts.slice(index + 1).some((rest) => rest !== "")) through.push(current.join("/"));
  }
  return through;
}

/** Archive member names: relative, no empty, `.` or `..` segments, no NUL. */
export function validMemberName(name: string): boolean {
  if (!name || name.includes("\0") || name.startsWith("/")) return false;
  return name.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
