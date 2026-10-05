import { ProjectCloneUrl, ProjectName, type ProjectFolderMatch } from "@ace/protocol";

const ignored = new Set([
  "node_modules",
  ".git",
  ".cache",
  "cache",
  "caches",
  "library",
  "__pycache__",
  ".ace",
  ".ace-next",
  ".ace-dev",
  "dist",
  "build",
  "coverage",
  "vendor",
  ".next",
  ".turbo",
]);
export function ignoredFolder(name: string, showHidden: boolean): boolean {
  return ignored.has(name.toLowerCase()) || (!showHidden && name.startsWith("."));
}
/** Name matches win over path matches; recent folders break close matches. */
export function folderScore(query: string, name: string, path: string): number | undefined {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const fuzzy = (value: string): number | undefined => {
    let cursor = 0;
    let gaps = 0;
    for (const char of needle) {
      const position = value.indexOf(char, cursor);
      if (position < 0) return undefined;
      gaps += position - cursor;
      cursor = position + 1;
    }
    return Math.max(1, 100 - gaps - (value.length - needle.length) / 10);
  };
  const lower = name.toLowerCase();
  if (lower === needle) return 1000;
  if (lower.startsWith(needle)) return 800 - (lower.length - needle.length) / 10;
  if (lower.includes(needle)) return 600 - lower.indexOf(needle);
  const score = fuzzy(lower);
  return score === undefined ? fuzzy(path.toLowerCase()) : 300 + score;
}
export function rankFolders(
  query: string,
  folders: readonly Omit<ProjectFolderMatch, "score">[],
  roots: readonly string[] = [],
): ProjectFolderMatch[] {
  return folders
    .flatMap((folder) => {
      const root = roots.find(
        (entry) =>
          folder.path === entry ||
          folder.path.startsWith(entry + "/") ||
          folder.path.startsWith(entry + "\\"),
      );
      const score = folderScore(
        query,
        folder.name,
        root ? folder.path.slice(root.length) : folder.path,
      );
      return score === undefined ? [] : [{ ...folder, score: score + folder.recentScore * 50 }];
    })
    .toSorted((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}
export function commonPrefix(values: readonly string[]): string {
  let prefix = values[0] ?? "";
  for (const value of values.slice(1)) {
    let length = 0;
    while (length < prefix.length && prefix[length] === value[length]) length++;
    prefix = prefix.slice(0, length);
  }
  return prefix;
}
/** Pure parsing shared by the real and fake host. Never contacts a forge. */
export function parseCloneUrl(input: string): { url: string; name: string } {
  const checked = ProjectCloneUrl.parse(input);
  const shorthand = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(checked);
  const url = shorthand
    ? `https://github.com/${checked}.git`.replace(/\.git\.git$/, ".git")
    : checked;
  const pathname = url.startsWith("git@") ? url.slice(url.indexOf(":") + 1) : new URL(url).pathname;
  const name = decodeURIComponent(pathname.replace(/\/+$/, "").split("/").at(-1) ?? "").replace(
    /\.git$/,
    "",
  );
  return { url, name: ProjectName.parse(name) };
}
/** Paths remain literal. Only the current user's tilde is expanded. */
export function completionParts(input: string, home: string, separator: string) {
  const expanded =
    input === "~"
      ? home + separator
      : input.startsWith("~/")
        ? home + separator + input.slice(2)
        : input;
  const position = expanded.lastIndexOf(separator);
  return {
    parent: expanded.endsWith(separator) ? expanded : expanded.slice(0, position + 1),
    prefix: expanded.endsWith(separator) ? "" : expanded.slice(position + 1),
    display: input === "~" ? "~/" : input.slice(0, input.lastIndexOf(separator) + 1),
  };
}
