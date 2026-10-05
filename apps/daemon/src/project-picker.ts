import { basename, join, sep } from "node:path";
import { ProjectDirectoryName, type ProjectFolderMatch, type ProjectsResult } from "@ace/protocol";
import {
  commonPrefix,
  completionParts,
  ignoredFolder,
  rankFolders,
  visibleFolder,
} from "@ace/project-picker";
import { ProjectDirectory } from "./project-directory.ts";
import { ProjectPaths, ProjectError, absoluteProjectPath } from "./project-policy.ts";
import type { ProjectStorage } from "./project-storage.ts";

type Folder = Omit<ProjectFolderMatch, "score">;
type Index = {
  root: string;
  refreshed: number;
  folders: Map<string, Folder>;
  queue: { path: string; depth: number; after?: string }[];
  visited: Set<string>;
  truncated: boolean;
};
/** Bounded, lazy BFS. No background traversal, watches, descriptors or persisted host paths. */
export class ProjectPicker {
  private indexes = new Map<string, Index>();
  private scanning = false;
  private paths: ProjectPaths;
  private catalog: ProjectStorage;
  private now: () => number;
  constructor(paths: ProjectPaths, catalog: ProjectStorage, now: () => number) {
    this.paths = paths;
    this.catalog = catalog;
    this.now = now;
  }
  private check(signal: AbortSignal, allowed: () => boolean): void {
    if (!allowed()) throw new ProjectError("forbidden");
    if (signal.aborted) throw new ProjectError("search_cancelled");
  }
  async search(
    input: { query: string; limit: number; showHidden: boolean },
    signal: AbortSignal,
    allowed: () => boolean,
  ): Promise<Extract<ProjectsResult["result"], { kind: "search" }>> {
    const roots = await this.paths.roots();
    for (const [key, index] of this.indexes)
      if (!roots.includes(index.root)) this.indexes.delete(key);
    const requestIndexes: Index[] = [];
    const deadline = this.now() + 35;
    const scoped = ProjectPaths.snapshot(roots);
    for (const root of roots) {
      const key = `${input.showHidden}:${root}`;
      let index = this.indexes.get(key);
      if (!index || this.now() - index.refreshed > 30_000) {
        index = {
          root,
          refreshed: this.now(),
          folders: new Map(),
          queue: [{ path: root, depth: 0 }],
          visited: new Set(),
          truncated: false,
        };
        if (this.indexes.size >= 32) {
          const oldest = this.indexes.keys().next().value;
          if (oldest !== undefined) this.indexes.delete(oldest);
        }
        this.indexes.set(key, index);
      }
      requestIndexes.push(index);
      if (this.scanning || this.now() >= deadline) continue;
      this.scanning = true;
      try {
        let visits = 0;
        while (index.queue.length && visits++ < 128 && this.now() < deadline) {
          this.check(signal, allowed);
          const next = index.queue.shift();
          if (!next || (next.after === undefined && index.visited.has(next.path))) continue;
          index.visited.add(next.path);
          let directory: ProjectDirectory | undefined;
          try {
            directory = await ProjectDirectory.open(scoped, next.path);
            this.check(signal, allowed);
            if (
              directory.path !== next.path ||
              !visibleFolder(directory.path, roots, input.showHidden)
            )
              continue;
            const folder = folderHint(directory);
            index.folders.set(folder.path, folder);
            if (next.depth >= 4) {
              index.truncated = true;
              continue;
            }
            const names = directory.handle.names();
            let examined = 0;
            let previous = next.after;
            for (const name of names) {
              if (name <= (next.after ?? "")) continue;
              if (examined++ >= 256 || this.now() >= deadline) {
                index.queue.unshift({
                  ...next,
                  after: previous ?? "",
                });
                break;
              }
              previous = name;
              if (
                ignoredFolder(name, input.showHidden) ||
                !ProjectDirectoryName.safeParse(name).success
              )
                continue;
              // Links are never traversed by the index, including links back into a root.
              if ((directory.handle.metadata(name).mode & 0o170000) !== 0o040000) continue;
              if (index.visited.size + index.queue.length >= 1024) {
                index.truncated = true;
                break;
              }
              index.queue.push({ path: join(directory.path, name), depth: next.depth + 1 });
            }
            directory.verify();
          } catch (error) {
            if (signal.aborted) {
              index.visited.delete(next.path);
              index.queue.unshift(next);
            }
            this.check(signal, allowed);
            if (error instanceof ProjectError && error.code === "system_directory") continue;
            index.truncated = true;
          } finally {
            await directory?.close();
          }
        }
      } finally {
        this.scanning = false;
      }
    }
    this.check(signal, allowed);
    const folders = new Map<string, Folder>();
    let truncated = false;
    for (const index of requestIndexes) {
      truncated ||= index.truncated || index.queue.length > 0;
      for (const [path, folder] of index.folders) folders.set(path, folder);
    }
    // Recent registrations can sit deeper than the index and still be useful picker results.
    for (const recent of this.catalog.recentHints(100)) {
      if (!visibleFolder(recent.path, roots, input.showHidden)) continue;
      folders.set(recent.path, {
        name: basename(recent.path),
        path: recent.path,
        isGitRepo: folders.get(recent.path)?.isGitRepo ?? false,
        isProject: true,
        lastOpened: recent.lastOpened,
        recentScore: recent.recentScore,
      });
    }
    const ranked = rankFolders(input.query, [...folders.values()], roots);
    const entries: ProjectFolderMatch[] = [];
    // Reopen only ranked candidates, so stale or replaced entries cannot escape containment.
    for (const match of ranked.slice(0, input.limit + 128)) {
      if (entries.length >= input.limit) break;
      this.check(signal, allowed);
      try {
        const directory = await ProjectDirectory.open(scoped, match.path);
        try {
          if (directory.path !== match.path) continue;
          const hint = folderHint(directory);
          directory.verify();
          entries.push({
            ...match,
            ...hint,
            recentScore: match.recentScore,
            ...this.catalog.folderFacts(match.path),
          });
        } finally {
          await directory.close();
        }
      } catch {
        this.check(signal, allowed);
        for (const index of requestIndexes) index.folders.delete(match.path);
      }
    }
    this.check(signal, allowed);
    return {
      kind: "search",
      query: input.query,
      indexing: requestIndexes.some((index) => index.queue.length > 0),
      entries,
      truncated: truncated || ranked.length > input.limit,
    };
  }
  async complete(
    input: { path: string; limit: number; showHidden: boolean },
    home: string,
    signal: AbortSignal,
    allowed: () => boolean,
  ): Promise<Extract<ProjectsResult["result"], { kind: "completion" }>> {
    const parts = completionParts(input.path, home, sep);
    absoluteProjectPath(parts.parent);
    const roots = await this.paths.roots();
    const scoped = ProjectPaths.snapshot(roots);
    const directory = await ProjectDirectory.open(scoped, parts.parent);
    const candidates: (ProjectFolderMatch & { completion: string })[] = [];
    const deadline = this.now() + 50;
    let truncated = false;
    const completions: string[] = [];
    try {
      const names = visibleFolder(directory.path, roots, input.showHidden)
        ? directory.handle.names()
        : [];
      let metadataReads = 0;
      for (const name of names) {
        this.check(signal, allowed);
        if (this.now() >= deadline) {
          truncated = true;
          break;
        }
        if (
          !name.startsWith(parts.prefix) ||
          ignoredFolder(name, input.showHidden) ||
          !ProjectDirectoryName.safeParse(name).success
        )
          continue;
        if (metadataReads++ >= 256) {
          truncated = true;
          break;
        }
        let kind: number;
        try {
          kind = directory.handle.metadata(name).mode & 0o170000;
        } catch {
          continue;
        }
        if (kind !== 0o040000 && kind !== 0o120000) continue;
        try {
          const child = await ProjectDirectory.open(scoped, join(directory.path, name));
          try {
            if (!visibleFolder(child.path, roots, input.showHidden)) continue;
            const completion = `${parts.display}${name}${sep}`;
            child.verify();
            completions.push(completion);
            if (candidates.length < input.limit)
              candidates.push({
                ...folderHint(child),
                name,
                ...this.catalog.folderFacts(child.path),
                score: 0,
                completion,
              });
          } finally {
            await child.close();
          }
        } catch {
          this.check(signal, allowed);
        }
      }
      directory.verify();
      this.check(signal, allowed);
      // An incomplete scan cannot safely extend the input past unseen candidates.
      return {
        kind: "completion",
        path: input.path,
        candidates,
        commonPrefix: truncated ? input.path : commonPrefix(completions),
        truncated: truncated || completions.length > input.limit,
      };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "LIMIT_EXCEEDED")
        throw new ProjectError("directory_too_large");
      throw error;
    } finally {
      await directory.close();
    }
  }
}
function folderHint(directory: ProjectDirectory): Folder {
  let isGitRepo = false;
  try {
    const kind = directory.handle.metadata(".git").mode & 0o170000;
    isGitRepo = kind === 0o040000 || kind === 0o100000;
  } catch {
    /* A folder may have no Git marker. */
  }
  return {
    name: basename(directory.path),
    path: directory.path,
    isGitRepo,
    isProject: false,
    recentScore: 0,
  };
}
