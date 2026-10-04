import { join } from "node:path";
import { ProjectDirectoryName, type ProjectsResult } from "@ace/protocol";
import { ProjectError, type ProjectPaths } from "./project-policy.ts";
import { ProjectDirectory } from "./project-directory.ts";

type DirectoryPage = Extract<ProjectsResult["result"], { kind: "directories" }>;
/** Descriptor-bound scan: at most 10,000 names and only page+1 directory metadata results. */
export async function browseProjects(
  paths: ProjectPaths,
  input: { path: string; after?: string | undefined; limit: number; showHidden: boolean },
): Promise<DirectoryPage> {
  const directory = await ProjectDirectory.open(paths, input.path);
  const entries: DirectoryPage["entries"] = [];
  try {
    for (const name of directory.handle.names()) {
      if (
        (!input.showHidden && name.startsWith(".")) ||
        name <= (input.after ?? "") ||
        !ProjectDirectoryName.safeParse(name).success
      )
        continue;
      let kind: number;
      try {
        kind = directory.handle.metadata(name).mode & 0o170000;
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code))
        )
          continue;
        throw error;
      }
      if (kind !== 0o040000 && kind !== 0o120000) continue;
      try {
        const child = await ProjectDirectory.open(paths, join(directory.path, name));
        try {
          const metadata = child.handle.stat();
          let git = false;
          try {
            const marker = child.handle.metadata(".git").mode & 0o170000;
            git = marker === 0o040000 || marker === 0o100000;
          } catch {
            /* Not a repository root. */
          }
          child.verify();
          entries.push({ name, path: child.path, git, modifiedAt: Math.max(0, metadata.mtimeMs) });
        } finally {
          await child.close();
        }
      } catch (error) {
        if (!(error instanceof ProjectError)) throw error;
        // Unreadable, escaping or replaced entries are absent from the picker.
      }
      if (entries.length > input.limit) break;
    }
    directory.verify();
    return {
      kind: "directories",
      path: directory.path,
      entries: entries.slice(0, input.limit),
      ...(entries.length > input.limit ? { next: entries[input.limit - 1]?.name } : {}),
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "LIMIT_EXCEEDED")
      throw new ProjectError("directory_too_large");
    throw error;
  } finally {
    await directory.close();
  }
}
