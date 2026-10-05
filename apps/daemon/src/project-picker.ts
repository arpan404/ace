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
import {
  pickerFilesystem,
  pickerNames,
  pickerKind,
  missingEntry,
  retryDirectory,
  type PickerFilesystem,
} from "./project-picker-filesystem.ts";
import type { ProjectStorage } from "./project-storage.ts";

type Folder = Omit<ProjectFolderMatch, "score">;
type Enumeration = { names: string[]; offset: number; dev: number; ino: number };
type Scan = { path: string; depth: number; enumeration?: Enumeration };
type Index = {
  root: string;
  refreshed: number;
  folders: Map<string, Folder>;
  queue: Scan[];
  scheduled: Set<string>;
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
  private filesystem: PickerFilesystem;
  constructor(
    paths: ProjectPaths,
    catalog: ProjectStorage,
    now: () => number,
    filesystem: PickerFilesystem = pickerFilesystem,
  ) {
    this.paths = paths;
    this.catalog = catalog;
    this.now = now;
    this.filesystem = filesystem;
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
          scheduled: new Set([root]),
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
          if (!next || (next.enumeration === undefined && index.visited.has(next.path))) continue;
          index.visited.add(next.path);
          let directory: ProjectDirectory | undefined;
          try {
            directory = await this.filesystem.open(scoped, next.path);
            this.check(signal, allowed);
            if (
              directory.path !== next.path ||
              !visibleFolder(directory.path, roots, input.showHidden, sep)
            )
              continue;
            const folder = folderHint(this.filesystem, directory);
            index.folders.set(folder.path, folder);
            if (next.depth >= 4) {
              index.truncated = true;
              continue;
            }
            const identity = directory.handle.stat();
            const enumeration =
              next.enumeration &&
              next.enumeration.dev === identity.dev &&
              next.enumeration.ino === identity.ino
                ? next.enumeration
                : {
                    names: pickerNames(this.filesystem, directory),
                    offset: 0,
                    dev: identity.dev,
                    ino: identity.ino,
                  };
            let examined = 0;
            while (enumeration.offset < enumeration.names.length) {
              if (examined++ >= 256 || this.now() >= deadline) {
                index.queue.unshift({ ...next, enumeration });
                break;
              }
              const name = enumeration.names[enumeration.offset++];
              if (
                name === undefined ||
                ignoredFolder(name, input.showHidden) ||
                !ProjectDirectoryName.safeParse(name).success
              )
                continue;
              let kind: number;
              try {
                kind = pickerKind(this.filesystem, directory, name);
              } catch (error) {
                if (!missingEntry(error)) index.truncated = true;
                continue;
              }
              // Links are never traversed by the index, including links back into a root.
              if (kind !== 0o040000) continue;
              const childPath = join(directory.path, name);
              if (index.scheduled.has(childPath)) continue;
              if (index.scheduled.size >= 1024) {
                index.truncated = true;
                break;
              }
              index.scheduled.add(childPath);
              index.queue.push({ path: childPath, depth: next.depth + 1 });
            }
            directory.verify();
          } catch (error) {
            if (signal.aborted || retryDirectory(error)) {
              index.visited.delete(next.path);
              index.queue.unshift(next);
            }
            this.check(signal, allowed);
            if (error instanceof ProjectError && error.code === "system_directory") continue;
            if (retryDirectory(error)) break;
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
      if (
        !visibleFolder(recent.path, roots, input.showHidden, sep) ||
        !ProjectDirectoryName.safeParse(basename(recent.path)).success
      )
        continue;
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
    let examined = 0;
    let hasMore = false;
    for (const match of ranked) {
      if (examined >= input.limit + 128) break;
      examined++;
      this.check(signal, allowed);
      try {
        const directory = await this.filesystem.open(scoped, match.path);
        try {
          if (directory.path !== match.path) {
            for (const index of requestIndexes) index.folders.delete(match.path);
            continue;
          }
          const hint = folderHint(this.filesystem, directory);
          directory.verify();
          if (entries.length >= input.limit) {
            hasMore = true;
            break;
          }
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
      truncated: truncated || hasMore || examined < ranked.length,
    };
  }
  async complete(
    input: { path: string; limit: number; showHidden: boolean },
    home: string,
    signal: AbortSignal,
    allowed: () => boolean,
  ): Promise<Extract<ProjectsResult["result"], { kind: "completion" }>> {
    const parts = completionParts(input.path, home, sep);
    absoluteProjectPath(parts.expanded);
    const roots = await this.paths.roots();
    const scoped = ProjectPaths.snapshot(roots);
    const directory = await this.filesystem.open(scoped, parts.parent);
    const candidates: (ProjectFolderMatch & { completion: string })[] = [];
    const deadline = this.now() + 50;
    let truncated = false;
    const completions: string[] = [];
    try {
      const names = visibleFolder(directory.path, roots, input.showHidden, sep)
        ? pickerNames(this.filesystem, directory)
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
          kind = pickerKind(this.filesystem, directory, name);
        } catch {
          continue;
        }
        if (kind !== 0o040000 && kind !== 0o120000) continue;
        try {
          const child = await this.filesystem.open(scoped, join(directory.path, name));
          try {
            if (!visibleFolder(child.path, roots, input.showHidden, sep)) continue;
            const completion = `${parts.display}${name}${sep}`;
            child.verify();
            completions.push(completion);
            if (candidates.length < input.limit)
              candidates.push({
                ...folderHint(this.filesystem, child),
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
function folderHint(filesystem: PickerFilesystem, directory: ProjectDirectory): Folder {
  let isGitRepo = false;
  try {
    const kind = pickerKind(filesystem, directory, ".git");
    isGitRepo = kind === 0o040000 || kind === 0o100000;
  } catch {
    /* A folder may have no Git marker. */
  }
  return {
    name: ProjectDirectoryName.parse(basename(directory.path)),
    path: directory.path,
    isGitRepo,
    isProject: false,
    recentScore: 0,
  };
}
