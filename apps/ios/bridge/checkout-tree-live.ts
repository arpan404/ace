import type { ClientCore } from "@ace/client";
import { ThreadId, type FolderPage, type GitStatusFile, type ServerMessage } from "@ace/protocol";
import {
  ancestorFolders,
  checkoutError,
  folderKey,
  folderPageArrived,
  folderPageFailed,
  folderRequestPath,
  foldersToRelist,
  startingFolderPage,
  watchedFolders,
  type FolderStates,
} from "@ace/ui-core";
import { z } from "zod";
import type { PatchSink } from "./agents.ts";
import { memoryKey } from "./checkout-memory.ts";
import { FilesScope } from "./checkout-request.ts";
import { treeRows, withDeletedEntries } from "./checkout-tree.ts";
import type { Timers } from "./kept-read.ts";

/*
 * The Files screen's live tree: the root is listed when the screen appears, a folder when the
 * person expands it, and another page when Show more is tapped. Open folders are watched
 * (`files.watch`, debounced) and listed again when the daemon names one (`files.folders_changed`)
 * or the socket comes back, so agent writes and other devices show up without a reload. Each
 * change answers with a `files.tree` patch of the rows the phone draws.
 */

/** How long a change in the open set waits before `files.watch` names it. */
const watchDelay = 150;
/** How long after a folder change the tree's git marks are read again. */
const statusDelay = 300;

const path = z.string().min(1).max(4096);
export const NativeTreeAction = z.discriminatedUnion("type", [
  /** The Files screen appeared (or came back from the background): list what it shows. */
  z.object({ type: z.literal("files.tree.show"), scope: FilesScope }),
  /** The Files screen closed or the app went to the background: stop watching its folders. */
  z.object({ type: z.literal("files.tree.hide"), scope: FilesScope }),
  /** A folder's row was expanded: its first page is listed. */
  z.object({ type: z.literal("files.tree.opened"), scope: FilesScope, path }),
  /** A folder's row was folded: its runs stop and its rows hide. */
  z.object({ type: z.literal("files.tree.closed"), scope: FilesScope, path }),
  /** Show more under a folder: its next page is listed. */
  z.object({ type: z.literal("files.tree.more"), scope: FilesScope, path }),
  /** A folder's first page failed: list it again from the start. */
  z.object({ type: z.literal("files.tree.retry"), scope: FilesScope, path }),
  /** After a change made from the phone: list the open folders again at once. */
  z.object({ type: z.literal("files.tree.refresh"), scope: FilesScope }),
]);
export type NativeTreeAction = z.infer<typeof NativeTreeAction>;

/** What the live tree needs of a client: its socket, its messages, and one-way sends. */
export type TreeOwner = Pick<ClientCore, "connectionGeneration" | "onMessage" | "send">;

/** What the live tree needs of the Files requests (`CheckoutFiles`). */
export interface TreeFiles {
  listFolder(
    scope: FilesScope,
    folder: string,
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<FolderPage>;
  status(threadId: string, signal: AbortSignal): Promise<readonly GitStatusFile[]>;
}

interface FolderRequest {
  token: number;
  controller: AbortController;
}

interface TreeState {
  scope: FilesScope;
  /** The patch key's scope ("thread:<id>" or "project:<id>"). */
  key: string;
  folders: FolderStates;
  /** The open folder keys, "" for the root. */
  open: Set<string>;
  changes: readonly GitStatusFile[];
  visible: boolean;
  /** Whether the folders holding a change have been opened once for this screen. */
  seeded: boolean;
  sequence: number;
  running: Map<string, FolderRequest>;
  status: AbortController | undefined;
  statusSequence: number;
  watch: (() => void) | undefined;
  statusRefresh: (() => void) | undefined;
  changed: (() => void) | undefined;
}

const scopeKey = (scope: FilesScope) => memoryKey(scope);

export class CheckoutTrees {
  readonly #owner: TreeOwner;
  readonly #files: TreeFiles;
  readonly #sink: Pick<PatchSink, "put">;
  readonly #timers: Timers;
  readonly #trees = new Map<string, TreeState>();
  #generation: number | undefined;

  constructor(owner: TreeOwner, files: TreeFiles, sink: Pick<PatchSink, "put">, timers: Timers) {
    this.#owner = owner;
    this.#files = files;
    this.#sink = sink;
    this.#timers = timers;
    const generation = owner.connectionGeneration();
    this.#generation = generation.getSnapshot();
    generation.subscribe(() => this.#moved(generation.getSnapshot()));
    owner.onMessage((message) => this.#message(message));
  }

  handle(action: NativeTreeAction): void {
    const tree = this.#tree(action.scope);
    switch (action.type) {
      case "files.tree.show":
        tree.visible = true;
        this.#show(tree);
        return;
      case "files.tree.hide":
        tree.visible = false;
        this.#stop(tree);
        this.#sendWatch(tree, []);
        return;
      case "files.tree.opened": {
        const folder = folderKey(action.path);
        tree.open.add(folder);
        this.#emit(tree);
        this.#list(tree, folder, "first");
        this.#scheduleWatch(tree);
        return;
      }
      case "files.tree.closed": {
        const folder = folderKey(action.path);
        tree.open.delete(folder);
        this.#stopFolder(tree, folder);
        this.#emit(tree);
        this.#scheduleWatch(tree);
        return;
      }
      case "files.tree.more":
        this.#list(tree, folderKey(action.path), "more");
        return;
      case "files.tree.retry":
        this.#list(tree, folderKey(action.path), "first");
        return;
      case "files.tree.refresh":
        this.#show(tree);
        return;
    }
  }

  /** The root and every open folder, from its first page, as a fresh screen or a reconnected one. */
  #show(tree: TreeState): void {
    if (!this.#ready()) {
      this.#emit(tree);
      return;
    }
    this.#refreshStatus(tree);
    this.#list(tree, "", "first");
    for (const folder of tree.open) if (folder) this.#list(tree, folder, "first");
    this.#scheduleWatch(tree);
  }

  /** `fresh` says a socket arrived (or returned): list the open folders again, don't reopen folds. */
  #moved(generation: number | undefined): void {
    const before = this.#generation;
    this.#generation = generation;
    if (generation === undefined) {
      for (const tree of this.#trees.values()) this.#stop(tree);
      return;
    }
    if (before === generation) return;
    for (const tree of this.#trees.values()) if (tree.visible) this.#show(tree);
  }

  #ready(): boolean {
    return this.#generation !== undefined;
  }

  #tree(scope: FilesScope): TreeState {
    const key = scopeKey(scope);
    const known = this.#trees.get(key);
    if (known) return known;
    const tree: TreeState = {
      scope,
      key,
      folders: {},
      open: new Set([""]),
      changes: [],
      visible: false,
      seeded: false,
      sequence: 0,
      running: new Map(),
      status: undefined,
      statusSequence: 0,
      watch: undefined,
      statusRefresh: undefined,
      changed: undefined,
    };
    this.#trees.set(key, tree);
    return tree;
  }

  /** List one folder's first or next page, dropping the answer of any run it replaces. */
  #list(tree: TreeState, folder: string, mode: "first" | "more", retried = false): void {
    if (!this.#ready() || !tree.visible) return;
    const nextCursor = tree.folders[folder]?.nextCursor;
    const cursor = mode === "more" && typeof nextCursor === "string" ? nextCursor : undefined;
    if (mode === "more" && cursor === undefined) return;
    this.#stopFolder(tree, folder);
    const controller = new AbortController();
    const token = ++tree.sequence;
    tree.running.set(folder, { token, controller });
    tree.folders = startingFolderPage(tree.folders, folder, mode === "first");
    this.#emit(tree);
    void this.#files
      .listFolder(tree.scope, folderRequestPath(folder), cursor, controller.signal)
      .then(
        (page) => {
          if (tree.running.get(folder)?.token !== token) return;
          tree.running.delete(folder);
          tree.folders = folderPageArrived(
            tree.folders,
            folder,
            withDeletedEntries(folder, page, tree.changes),
            cursor,
          );
          this.#emit(tree);
        },
        (error: unknown) => {
          if (controller.signal.aborted || tree.running.get(folder)?.token !== token) return;
          tree.running.delete(folder);
          const failure = checkoutError(error);
          tree.folders = folderPageFailed(tree.folders, folder, failure);
          this.#emit(tree);
          // The cursor outlived its folder: list it again from the start, once.
          if (failure.code === "INVALID_CURSOR" && !retried)
            this.#list(tree, folder, "first", true);
        },
      );
  }

  /** Read the checkout's git status again, then open the folders holding a change the first time. */
  #refreshStatus(tree: TreeState): void {
    if (!("threadId" in tree.scope)) {
      this.#emit(tree);
      return;
    }
    tree.status?.abort();
    const controller = new AbortController();
    tree.status = controller;
    const token = ++tree.statusSequence;
    void this.#files.status(tree.scope.threadId, controller.signal).then(
      (changes) => {
        if (tree.statusSequence !== token || !tree.visible) return;
        tree.status = undefined;
        tree.changes = changes;
        if (tree.seeded) {
          this.#emit(tree);
          return;
        }
        tree.seeded = true;
        this.#reveal(tree, changes);
      },
      () => {
        // The marks are extra: a checkout git can't read still lists its files.
        if (tree.statusSequence === token) {
          tree.status = undefined;
          tree.seeded = true;
        }
      },
    );
  }

  /** The folders holding uncommitted changes start open, as the web's Files tree shows them. */
  #reveal(tree: TreeState, changes: readonly GitStatusFile[]): void {
    for (const change of changes)
      for (const folder of ancestorFolders(change.path)) {
        if (tree.open.has(folder)) continue;
        tree.open.add(folder);
        this.#list(tree, folder, "first");
      }
    this.#emit(tree);
    this.#scheduleWatch(tree);
  }

  /** A `files.folders_changed` names the watched folders to list again; a rescan names all. */
  #message(message: ServerMessage): void {
    if (message.type === "files.folders_changed") {
      for (const tree of this.#trees.values()) {
        if (!tree.visible || !("threadId" in tree.scope)) continue;
        if (tree.scope.threadId !== message.threadId) continue;
        for (const folder of foldersToRelist(tree.open, message.folders, message.rescan))
          this.#list(tree, folder, "first");
        this.#scheduleStatusRefresh(tree);
      }
      return;
    }
    // A project's own folder has no watcher: its changes come as the checkout's change messages.
    if (message.type === "files.changed") {
      for (const tree of this.#trees.values())
        if (tree.visible && "workspaceId" in tree.scope) this.#scheduleProjectRefresh(tree);
      return;
    }
    if (message.type !== "events") return;
    for (const event of message.events) {
      const payload = event.payload;
      if (payload.type !== "workspace.files_changed") continue;
      for (const tree of this.#trees.values())
        if (
          tree.visible &&
          "workspaceId" in tree.scope &&
          tree.scope.workspaceId === payload.workspaceId
        )
          this.#scheduleProjectRefresh(tree);
    }
  }

  #scheduleStatusRefresh(tree: TreeState): void {
    tree.statusRefresh?.();
    tree.statusRefresh = this.#timers.set(statusDelay, () => {
      tree.statusRefresh = undefined;
      if (tree.visible) this.#refreshStatus(tree);
    });
  }

  #scheduleProjectRefresh(tree: TreeState): void {
    tree.changed?.();
    tree.changed = this.#timers.set(watchDelay, () => {
      tree.changed = undefined;
      if (!tree.visible || !this.#ready()) return;
      this.#refreshStatus(tree);
      this.#list(tree, "", "first");
      for (const folder of tree.open) if (folder) this.#list(tree, folder, "first");
    });
  }

  /** `files.watch`: the root and the open folders, each change of the set sent once it settles. */
  #scheduleWatch(tree: TreeState): void {
    tree.watch?.();
    tree.watch = undefined;
    if (!("threadId" in tree.scope) || !this.#ready()) return;
    tree.watch = this.#timers.set(watchDelay, () => {
      tree.watch = undefined;
      if (!tree.visible || !this.#ready()) return;
      if (!("threadId" in tree.scope)) return;
      this.#sendWatch(tree, watchedFolders(tree.open));
    });
  }

  #sendWatch(tree: TreeState, folders: string[]): void {
    if (!("threadId" in tree.scope)) return;
    try {
      this.#owner.send({
        type: "files.watch",
        threadId: ThreadId.parse(tree.scope.threadId),
        folders,
      });
    } catch {
      // A disconnect can race the send; the next socket sends the set again.
    }
  }

  #stop(tree: TreeState): void {
    for (const request of tree.running.values()) request.controller.abort();
    tree.running.clear();
    this.#stopStatus(tree);
    tree.watch?.();
    tree.watch = undefined;
    tree.statusRefresh?.();
    tree.statusRefresh = undefined;
    tree.changed?.();
    tree.changed = undefined;
  }

  #stopFolder(tree: TreeState, folder: string): void {
    const request = tree.running.get(folder);
    if (!request) return;
    request.controller.abort();
    tree.running.delete(folder);
  }

  #stopStatus(tree: TreeState): void {
    tree.status?.abort();
    tree.status = undefined;
    tree.statusSequence++;
  }

  /** The rows the screen draws: a folder's listed entries under it, with its loading and more rows. */
  #emit(tree: TreeState): void {
    if (!tree.visible) return;
    const rows = treeRows(tree.folders, tree.open, tree.changes);
    this.#sink.put(`files.tree:${tree.key}`, () => ({
      type: "files.tree",
      key: tree.key,
      rows,
    }));
  }
}
