import { GitIgnore } from "./ignore.ts";
import { list } from "./list.ts";
import { read } from "./read.ts";
import { SafeRoot } from "./safety.ts";
import { failure, type ListOptions, type ReadOptions, type WorkspaceOptions } from "./types.ts";
export { WorkspaceError } from "./types.ts";
export type {
  WorkspaceErrorCode,
  Entry,
  ListOptions,
  ListResult,
  ReadOptions,
  ReadResult,
  SearchOptions,
  SearchResult,
  Match,
  Change,
  WatchOptions,
  WorkspaceWatcher,
  WorkspaceOptions,
} from "./types.ts";

/** A root-bound service for browsing and reading workspace files. */
export async function createWorkspace(root: string, _options: WorkspaceOptions = {}) {
  const safe = await SafeRoot.create(root);
  const ignore = await GitIgnore.create(safe);
  return {
    root: safe.root,
    async list(request: ListOptions) {
      try {
        return await list(safe, ignore, request);
      } catch (error) {
        throw failure(error);
      }
    },
    async read(request: ReadOptions) {
      try {
        return await read(safe, request);
      } catch (error) {
        throw failure(error);
      }
    },
  };
}
export type Workspace = Awaited<ReturnType<typeof createWorkspace>>;
