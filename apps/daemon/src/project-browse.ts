import { opendir, stat, lstat } from "node:fs/promises";
import { join } from "node:path";
import { ProjectDirectoryName, type ProjectsResult } from "@ace/protocol";
import { ProjectError, type ProjectPaths } from "./project-policy.ts";

type DirectoryPage = Extract<ProjectsResult["result"], { kind: "directories" }>;
/** Scan at most 10,000 dirents and retain only a page plus one; no unbounded readdir. */
export async function browseProjects(
  paths: ProjectPaths,
  input: { path: string; after?: string | undefined; limit: number; showHidden: boolean },
): Promise<DirectoryPage> {
  const path = await paths.directory(input.path);
  const directory = await opendir(path);
  const entries: DirectoryPage["entries"] = [];
  let scanned = 0;
  for await (const entry of directory) {
    if (++scanned > 10_000) throw new ProjectError("directory_too_large");
    if (
      (!input.showHidden && entry.name.startsWith(".")) ||
      entry.name <= (input.after ?? "") ||
      !ProjectDirectoryName.safeParse(entry.name).success
    )
      continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    // Once a page is retained, only candidates sorting before its last entry need I/O.
    if (entries.length > input.limit && entry.name >= (entries.at(-1)?.name ?? "")) continue;
    try {
      const target = await paths.directory(join(path, entry.name));
      const metadata = await stat(target);
      let git = false;
      try {
        const marker = await lstat(join(target, ".git"));
        git = marker.isDirectory() || marker.isFile();
      } catch {
        /* Not a repository root. */
      }
      entries.push({
        name: entry.name,
        path: target,
        git,
        modifiedAt: Math.max(0, metadata.mtimeMs),
      });
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      if (entries.length > input.limit + 1) entries.pop();
    } catch (error) {
      if (!(error instanceof ProjectError)) throw error;
      // Unreadable or escaping entries are absent from the picker.
    }
  }
  return {
    kind: "directories",
    path,
    entries: entries.slice(0, input.limit),
    ...(entries.length > input.limit ? { next: entries[input.limit - 1]?.name } : {}),
  };
}
