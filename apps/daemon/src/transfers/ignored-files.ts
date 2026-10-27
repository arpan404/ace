/**
 * Which ignored files travel with a transfer (ADR 0101 "Ignored files"). Local files such as
 * `.env` and editor config go; folders that are platform-specific or rebuilt there stay, and so
 * do nested Git repositories, which are their own projects.
 */

/** Folder names that are dependencies or caches, wherever they appear. */
const rebuiltNames = new Set([
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pnpm-store",
  ".gradle",
  ".next",
  ".turbo",
  ".cache",
  "target",
]);
/** Folder paths, by their last two segments. */
const rebuiltPairs = new Set([".yarn/cache"]);

/** True when an ignored member (folder-relative `path`) and everything under it stays here. */
export function staysBehind(member: {
  path: string;
  kind: "file" | "directory" | "symlink";
  /** A folder's entry names, when known. */
  names?: readonly string[];
}): boolean {
  if (member.kind !== "directory") return false;
  return rebuiltFolder(member.path) || (member.names?.includes(".git") ?? false);
}

/** True when the folder at `path` holds dependencies or caches, rebuilt wherever it lands. */
export function rebuiltFolder(path: string): boolean {
  const parts = path.split("/");
  return rebuiltNames.has(parts.at(-1) ?? "") || rebuiltPairs.has(parts.slice(-2).join("/"));
}

/**
 * The paths Git listed as ignored, without those that stay behind by name. A path ending in `/`
 * is a whole folder; nested repositories are recognised later, when their entries are read.
 */
export function ignoredSelection(paths: readonly string[]): string[] {
  return paths.filter((path) => {
    const folder = path.endsWith("/");
    const parts = (folder ? path.slice(0, -1) : path).split("/");
    // Any folder on the way, or the path itself when it is a folder.
    for (let end = 1; end <= parts.length; end++) {
      if (end === parts.length && !folder) break;
      if (staysBehind({ path: parts.slice(0, end).join("/"), kind: "directory" })) return false;
    }
    return parts.at(-1) !== ".git";
  });
}

/**
 * On the receiving machine: a member that must never be written, whatever the sender sent.
 * Anything in a `.git` folder or file (any case, for case-insensitive disks) could change the
 * repository or plant hooks.
 */
export function neverPlaced(path: string): boolean {
  return path.split("/").some((part) => part.toLowerCase() === ".git");
}
