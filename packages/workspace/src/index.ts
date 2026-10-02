import { GitIgnore } from "./ignore.ts";
import { list } from "./list.ts";
import { read } from "./read.ts";
import { SafeRoot } from "./safety.ts";
import { search } from "./search.ts";
import { watch } from "./watch.ts";
import {
  failure,
  type ListOptions,
  type ReadOptions,
  type SearchOptions,
  type WatchOptions,
  type WorkspaceOptions,
} from "./types.ts";
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

/** A root-bound service. Watch subscriptions own their own disposal lifetime. */
export async function createWorkspace(root: string, options: WorkspaceOptions = {}) {
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
    async search(request: SearchOptions) {
      try {
        return await search(
          safe,
          ignore,
          options.ripgrep === undefined ? "rg" : options.ripgrep,
          request,
        );
      } catch (error) {
        throw failure(error);
      }
    },
    async watch(request: WatchOptions) {
      try {
        return await watch(safe, ignore, request, options.watchMode === "polling");
      } catch (error) {
        throw failure(error);
      }
    },
  };
}
export type Workspace = Awaited<ReturnType<typeof createWorkspace>>;

// Shared filesystem boundary for services that stream or mutate workspace files.
export { SafeRoot } from "./safety.ts";
export { GitIgnore } from "./ignore.ts";
export { tree as walkWorkspace } from "./tree.ts";
