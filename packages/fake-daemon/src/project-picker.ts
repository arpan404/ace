import { commonPrefix, completionParts, ignoredFolder, rankFolders } from "@ace/project-picker";
import type { ProjectFolderMatch, ProjectsResult } from "@ace/protocol";

type Folder = Omit<ProjectFolderMatch, "score">;
export function fakeSearch(
  input: { query: string; limit: number; showHidden: boolean },
  folders: Folder[],
  roots: string[],
): Extract<ProjectsResult["result"], { kind: "search" }> {
  const visible = folders.filter((folder) =>
    roots.some((root) => {
      if (folder.path !== root && !folder.path.startsWith(root + "/")) return false;
      const parts = folder.path.slice(root.length).split("/").filter(Boolean);
      return (
        (parts.length <= 4 || folder.recentScore > 0) &&
        !parts.some((part) => ignoredFolder(part, input.showHidden))
      );
    }),
  );
  const entries = rankFolders(input.query, visible.slice(0, 32768), roots);
  return {
    kind: "search",
    query: input.query,
    indexing: false,
    entries: entries.slice(0, input.limit),
    truncated: visible.length > 32768 || entries.length > input.limit,
  };
}
export function fakeComplete(
  input: { path: string; limit: number; showHidden: boolean },
  folders: Folder[],
  home: string,
  checked: (path: string) => string,
): Extract<ProjectsResult["result"], { kind: "completion" }> {
  const parts = completionParts(input.path, home, "/");
  const parent = checked(parts.parent);
  if (!folders.some((folder) => folder.path === parent)) throw new Error("directory_unavailable");
  const candidates = folders
    .filter(
      (folder) =>
        folder.path.startsWith(parent + "/") &&
        !folder.path.slice(parent.length + 1).includes("/") &&
        folder.name.startsWith(parts.prefix) &&
        !ignoredFolder(folder.name, input.showHidden),
    )
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((folder) =>
      Object.assign({}, folder, { score: 0, completion: `${parts.display}${folder.name}/` }),
    );
  return {
    kind: "completion",
    path: input.path,
    candidates: candidates.slice(0, input.limit),
    commonPrefix: commonPrefix(candidates.map((folder) => folder.completion)),
    truncated: candidates.length > input.limit,
  };
}
