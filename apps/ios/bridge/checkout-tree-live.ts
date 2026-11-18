import type { ClientCore } from "@ace/client";
import { ThreadId, type FolderPage, type GitStatusFile, type ServerMessage } from "@ace/protocol";
import {
  ancestorFolders,
  checkoutError,
  folderKey,
  folderPageArrived,
  folderPageFailed,
  folderRequestRepeated,
  folderRequestSettled,
  folderRequestStarted,
  folderRequestPath,
  folderStopped,
  foldersToRelist,
  noFolderRequests,
  orderedFolderRequests,
  parentPath,
  relistLimit,
  retryPage,
  startingFolderPage,
  visibleOpenFolders,
  watchedFolders,
  type FolderRequestState,
  type FolderStates,
} from "@ace/ui-core";
import { z } from "zod";
import type { PatchSink } from "./agents.ts";
import { memoryKey } from "./checkout-memory.ts";
import { FilesScope } from "./checkout-request.ts";
import { treeRows, withDeletedEntries } from "./checkout-tree.ts";
import type { Timers } from "./kept-read.ts";

/*
 * The Files screen's live tree: the root is listed when the screen appears, a folder when it
 * becomes visible, and another page when Show more is tapped. Visible folders are watched
 * (`files.watch`, debounced) and listed again when the daemon names one (`files.folders_changed`)
 * or the socket comes back, so agent writes and other devices show up without a reload. A change
 * asked for while a folder is being listed waits for that page instead of aborting it. Each
 * change answers with a `files.tree` patch whose rows are built when the patch is pulled.
 */

/** How long a change in what is on screen waits before `files.watch` names it. */
const watchDelay = 150;
/** How long after a folder change the tree's git marks are read again. */
const statusDelay = 300;
/** One page of a folder: Show more asks for the next, a re-list asks for what is shown. */
const pageSize = 500;
/** The most folder listings the phone has on their way at once. */
export const treeRequestLimit = 4;
/** The pages kept after a tree's last screen closes, most recently hidden last. */
const hiddenTreesKept = 3;

const path = z.string().min(1).max(4096);
export const NativeTreeAction = z.discriminatedUnion("type", [
  /** A Files screen appeared (or came back to the foreground): list what it shows. */
  z.object({ type: z.literal("files.tree.show"), scope: FilesScope }),
  /** A Files screen left or the app went to the background: stop watching when none is left. */
  z.object({ type: z.literal("files.tree.hide"), scope: FilesScope }),
  /** A folder's row was expanded: it and any open folder under it are listed. */
  z.object({ type: z.literal("files.tree.opened"), scope: FilesScope, path }),
  /** A folder's row was folded: nothing under it is listed or watched until it opens again. */
  z.object({ type: z.literal("files.tree.closed"), scope: FilesScope, path }),
  /** Show more under a folder: its next page is listed. */
  z.object({ type: z.literal("files.tree.more"), scope: FilesScope, path }),
  /** Try again under a failed folder: the failed page, or its first. */
  z.object({ type: z.literal("files.tree.retry"), scope: FilesScope, path }),
  /** After a change made from the phone: list the visible folders again at once. */
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
    limit: number,
    signal: AbortSignal,
  ): Promise<FolderPage>;
  status(threadId: string, signal: AbortSignal): Promise<readonly GitStatusFile[]>;
}

export interface TreeOptions {
  /** The most folder listings on their way at once; the phone uses four. */
  requestLimit?: number;
}

interface Queued {
  mode: "first" | "more";
  retried: boolean;
}

interface TreeState {
  scope: FilesScope;
  /** The patch key's scope ("thread:<id>" or "project:<id>"). */
  key: string;
  folders: FolderStates;
  /** The open folder keys, "" for the root; a descendant stays here when its parent folds. */
  open: Set<string>;
  changes: readonly GitStatusFile[];
  /** How many Files screens show this tree. Only zero stops watching and listing. */
  visibility: number;
  /** Whether the folders holding a change have been opened once for this screen. */
  seeded: boolean;
  /** Visible folders to list from their first page the next time the tree shows. */
  stale: Set<string>;
  /** The next show lists every visible folder from the start. */
  refreshAll: boolean;
  /** The next watch send happens even when the set is unchanged. */
  resendWatch: boolean;
  /** The watch set last sent, "" after hide; undefined when the daemon's set is unknown. */
  watchSent: string | undefined;
  sequence: number;
  requests: FolderRequestState;
  controllers: Map<string, AbortController>;
  active: number;
  queue: Map<string, Queued>;
  status: AbortController | undefined;
  statusSequence: number;
  watch: (() => void) | undefined;
  statusRefresh: (() => void) | undefined;
}

const scopeKey = (scope: FilesScope) => memoryKey(scope);

export class CheckoutTrees {
  readonly #owner: TreeOwner;
  readonly #files: TreeFiles;
  readonly #sink: Pick<PatchSink, "put">;
  readonly #timers: Timers;
  readonly #requestLimit: number;
  readonly #trees = new Map<string, TreeState>();
  /** Trees hidden with their pages kept, oldest first. */
  readonly #hidden: string[] = [];
  #generation: number | undefined;

  constructor(
    owner: TreeOwner,
    files: TreeFiles,
    sink: Pick<PatchSink, "put">,
    timers: Timers,
    options: TreeOptions = {},
  ) {
    this.#owner = owner;
    this.#files = files;
    this.#sink = sink;
    this.#timers = timers;
    this.#requestLimit = Math.max(1, options.requestLimit ?? treeRequestLimit);
    const generation = owner.connectionGeneration();
    this.#generation = generation.getSnapshot();
    generation.subscribe(() => this.#moved(generation.getSnapshot()));
    owner.onMessage((message) => this.#message(message));
  }

  handle(action: NativeTreeAction): void {
    if (action.type === "files.tree.show") {
      this.#show(this.#tree(action.scope));
      return;
    }
    const tree = this.#trees.get(scopeKey(action.scope));
    if (!tree) return;
    switch (action.type) {
      case "files.tree.hide":
        this.#hide(tree);
        return;
      case "files.tree.opened":
        this.#open(tree, folderKey(action.path));
        return;
      case "files.tree.closed":
        this.#close(tree, folderKey(action.path));
        return;
      case "files.tree.more": {
        const folder = folderKey(action.path);
        if (this.#visible(tree).has(folder)) this.#request(tree, folder, "more");
        return;
      }
      case "files.tree.retry": {
        const folder = folderKey(action.path);
        if (!this.#visible(tree).has(folder)) return;
        this.#request(tree, folder, retryPage(tree.folders[folder]).mode);
        return;
      }
      case "files.tree.refresh":
        this.#refresh(tree);
        return;
    }
  }

  #show(tree: TreeState): void {
    tree.visibility += 1;
    if (tree.visibility !== 1) return;
    this.#forgetHidden(tree);
    this.#resume(tree);
  }

  #hide(tree: TreeState): void {
    if (tree.visibility === 0) return;
    tree.visibility -= 1;
    if (tree.visibility > 0) return;
    this.#stop(tree);
    this.#sendWatch(tree, [], true);
    this.#rememberHidden(tree);
  }

  #open(tree: TreeState, folder: string): void {
    const before = this.#visible(tree);
    tree.open.add(folder);
    const after = this.#visible(tree);
    this.#requestAll(
      tree,
      [...after].filter((each) => !before.has(each)),
      "first",
    );
    this.#emit(tree);
    this.#scheduleWatch(tree);
  }

  #close(tree: TreeState, folder: string): void {
    const before = this.#visible(tree);
    tree.open.delete(folder);
    const after = this.#visible(tree);
    for (const each of before) if (!after.has(each)) this.#stopFolder(tree, each);
    this.#emit(tree);
    this.#scheduleWatch(tree);
  }

  /** A change made from the phone: every visible folder lists again, keeping its pages. */
  #refresh(tree: TreeState): void {
    if (tree.visibility === 0) return;
    this.#scheduleStatusRefresh(tree);
    this.#requestAll(tree, this.#visible(tree), "first");
    this.#emit(tree);
  }

  /** List what the screen shows: everything on a first show, only stale folders after a hide. */
  #resume(tree: TreeState): void {
    if (tree.visibility === 0) return;
    const visible = this.#visible(tree);
    for (const folder of visible) {
      const state = tree.folders[folder];
      if (
        !state ||
        (state.nextCursor === undefined &&
          !state.loading &&
          !state.error &&
          state.entries.length === 0)
      )
        tree.stale.add(folder);
    }
    if (tree.refreshAll || Object.keys(tree.folders).length === 0) {
      tree.refreshAll = false;
      tree.stale.clear();
      this.#requestAll(tree, visible, "first");
    } else {
      const stale = [...tree.stale].filter((folder) => visible.has(folder));
      tree.stale.clear();
      this.#requestAll(tree, stale, "first");
    }
    if (tree.seeded) this.#scheduleStatusRefresh(tree);
    else this.#refreshStatus(tree);
    this.#scheduleWatch(tree);
    this.#emit(tree);
  }

  #moved(generation: number | undefined): void {
    const before = this.#generation;
    this.#generation = generation;
    if (generation === undefined) {
      for (const tree of this.#trees.values()) {
        tree.refreshAll = true;
        this.#stop(tree);
      }
      return;
    }
    if (before === generation) return;
    for (const tree of this.#trees.values()) {
      tree.refreshAll = true;
      tree.resendWatch = true;
      if (tree.visibility > 0) this.#resume(tree);
    }
  }

  #ready(): boolean {
    return this.#generation !== undefined;
  }

  #visible(tree: TreeState): ReadonlySet<string> {
    return visibleOpenFolders(tree.open);
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
      visibility: 0,
      seeded: false,
      stale: new Set(),
      refreshAll: false,
      resendWatch: false,
      watchSent: undefined,
      sequence: 0,
      requests: noFolderRequests,
      controllers: new Map(),
      active: 0,
      queue: new Map(),
      status: undefined,
      statusSequence: 0,
      watch: undefined,
      statusRefresh: undefined,
    };
    this.#trees.set(key, tree);
    return tree;
  }

  /** Ask for a page; a re-list asked for while a page is on its way waits for it. */
  #request(tree: TreeState, folder: string, mode: "first" | "more", retried = false): void {
    this.#enqueue(tree, folder, mode, retried);
    this.#pump(tree);
  }

  /** Ask for several pages together, so the queue starts the shallow ones first. */
  #requestAll(tree: TreeState, folders: Iterable<string>, mode: "first" | "more"): void {
    for (const folder of folders) this.#enqueue(tree, folder, mode);
    this.#pump(tree);
  }

  #enqueue(tree: TreeState, folder: string, mode: "first" | "more", retried = false): void {
    const key = folderKey(folder);
    if (!this.#visible(tree).has(key)) return;
    if (tree.visibility === 0 || !this.#ready()) {
      tree.stale.add(key);
      return;
    }
    if (tree.requests.requests[key]) {
      if (mode === "first") tree.requests = folderRequestRepeated(tree.requests, key);
      return;
    }
    const queued = tree.queue.get(key);
    if (!queued || mode === "first") tree.queue.set(key, { mode, retried });
  }

  /** Start queued pages while fewer than the cap are on their way, root and shallow first. */
  #pump(tree: TreeState): void {
    if (tree.visibility === 0 || !this.#ready()) return;
    const visible = this.#visible(tree);
    for (const folder of tree.queue.keys()) if (!visible.has(folder)) tree.queue.delete(folder);
    while (tree.active < this.#requestLimit) {
      const next = orderedFolderRequests(
        [...tree.queue].map(([folder, queued]) => ({ folder, mode: queued.mode })),
        visible,
      )[0];
      if (!next) return;
      const queued = tree.queue.get(next.folder);
      tree.queue.delete(next.folder);
      if (queued) this.#run(tree, next.folder, queued.mode, queued.retried);
    }
  }

  #run(tree: TreeState, folder: string, mode: "first" | "more", retried: boolean): void {
    if (tree.visibility === 0 || !this.#ready() || !this.#visible(tree).has(folder)) return;
    const state = tree.folders[folder];
    const cursor =
      mode === "more" && typeof state?.nextCursor === "string" ? state.nextCursor : undefined;
    if (mode === "more" && cursor === undefined) return;
    // A re-list asks for what the folder already shows, so the rows it has stay put.
    const limit = mode === "more" ? pageSize : relistLimit(state);
    const controller = new AbortController();
    const token = ++tree.sequence;
    tree.requests = folderRequestStarted(tree.requests, folder, token);
    tree.controllers.set(folder, controller);
    tree.active += 1;
    tree.folders = startingFolderPage(tree.folders, folder, mode === "first");
    this.#emit(tree);
    void this.#files
      .listFolder(tree.scope, folderRequestPath(folder), cursor, limit, controller.signal)
      .then(
        (page) => this.#settle(tree, folder, token, { page, cursor, retried }),
        (error: unknown) => this.#settle(tree, folder, token, { error, cursor, retried }),
      );
  }

  #settle(
    tree: TreeState,
    folder: string,
    token: number,
    result:
      | { page: FolderPage; cursor: string | undefined; retried: boolean }
      | { error: unknown; cursor: string | undefined; retried: boolean },
  ): void {
    tree.active = Math.max(0, tree.active - 1);
    const current = tree.requests.requests[folder]?.token === token;
    const settled = folderRequestSettled(tree.requests, folder, token);
    tree.requests = settled.state;
    if (!current || tree.visibility === 0) {
      this.#pump(tree);
      return;
    }
    tree.controllers.delete(folder);
    if ("page" in result) {
      tree.folders = folderPageArrived(
        tree.folders,
        folder,
        withDeletedEntries(folder, result.page, tree.changes),
        result.cursor,
      );
      this.#emit(tree);
      if (settled.relist) this.#request(tree, folder, "first");
    } else {
      const failure = checkoutError(result.error);
      if (failure.code === "INVALID_CURSOR" && !result.retried) {
        tree.folders = folderPageFailed(tree.folders, folder, failure);
        this.#emit(tree);
        this.#request(tree, folder, "first", true);
      } else {
        // The folder changed again after the one retry: say what happened and leave it be.
        const reported =
          failure.code === "INVALID_CURSOR"
            ? { code: "INVALID_CURSOR_RETRIED", message: failure.message }
            : failure;
        tree.folders = folderPageFailed(tree.folders, folder, reported);
        this.#emit(tree);
        if (settled.relist) this.#request(tree, folder, "first");
      }
    }
    this.#pump(tree);
  }

  /** Every request for the tree stops: folding, hiding, or losing the socket. */
  #stop(tree: TreeState): void {
    for (const [folder, controller] of tree.controllers) {
      controller.abort();
      const token = tree.requests.requests[folder]?.token;
      if (token !== undefined)
        tree.requests = folderRequestSettled(tree.requests, folder, token).state;
      tree.folders = folderStopped(tree.folders, folder);
      tree.stale.add(folder);
    }
    tree.controllers.clear();
    for (const folder of tree.queue.keys()) tree.stale.add(folder);
    tree.queue.clear();
    tree.requests = noFolderRequests;
    tree.watch?.();
    tree.watch = undefined;
    tree.statusRefresh?.();
    tree.statusRefresh = undefined;
    tree.status?.abort();
    tree.status = undefined;
    tree.statusSequence++;
    if (tree.visibility > 0) this.#emit(tree);
  }

  #stopFolder(tree: TreeState, folder: string): void {
    tree.queue.delete(folder);
    const controller = tree.controllers.get(folder);
    if (controller) {
      controller.abort();
      const token = tree.requests.requests[folder]?.token;
      if (token !== undefined)
        tree.requests = folderRequestSettled(tree.requests, folder, token).state;
      tree.controllers.delete(folder);
    }
    tree.folders = folderStopped(tree.folders, folder);
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
        if (tree.statusSequence !== token || tree.visibility === 0) return;
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
    const before = this.#visible(tree);
    for (const change of changes)
      for (const folder of ancestorFolders(change.path)) tree.open.add(folder);
    const after = this.#visible(tree);
    const added = [...after].filter((folder) => !before.has(folder));
    // A folder read before git answered may miss a deleted file, which is a row git names and
    // the folder no longer holds.
    const deleted = new Set<string>();
    for (const change of changes)
      if (change.status === "deleted") deleted.add(folderKey(parentPath(change.path)));
    this.#requestAll(
      tree,
      [...added, ...[...deleted].filter((folder) => before.has(folder))],
      "first",
    );
    this.#emit(tree);
    if (after.size !== before.size) this.#scheduleWatch(tree);
  }

  #message(message: ServerMessage): void {
    if (message.type === "files.folders_changed") {
      for (const tree of this.#trees.values()) {
        if (!("threadId" in tree.scope) || tree.scope.threadId !== message.threadId) continue;
        if (tree.visibility === 0) {
          // Hidden: the pages kept are listed again only for what changed.
          const named = message.rescan
            ? [...tree.open]
            : foldersToRelist(tree.open, message.folders, false);
          for (const folder of named) tree.stale.add(folder);
          continue;
        }
        const visible = this.#visible(tree);
        const changed = message.rescan
          ? [...visible]
          : foldersToRelist(visible, message.folders, false);
        this.#requestAll(tree, changed, "first");
        this.#scheduleStatusRefresh(tree);
      }
      return;
    }
    // A thread's own operations name the folders their paths left or landed in.
    if (message.type === "files.changed") {
      for (const tree of this.#trees.values())
        if ("threadId" in tree.scope) this.#changed(tree, [message.change]);
      return;
    }
    if (message.type !== "events") return;
    // A project's own folder has no watcher: its changes come as workspace events.
    for (const event of message.events) {
      const payload = event.payload;
      if (payload.type !== "workspace.files_changed") continue;
      for (const tree of this.#trees.values())
        if ("workspaceId" in tree.scope && tree.scope.workspaceId === payload.workspaceId)
          this.#changed(tree, [payload.change]);
    }
  }

  /** List the open folders that hold the parents of what changed, and no others. */
  #changed(
    tree: TreeState,
    changes: readonly { path: string; destination?: string | undefined }[],
  ): void {
    const folders = new Set<string>();
    for (const change of changes)
      for (const touched of [change.path, change.destination])
        if (touched) folders.add(folderKey(parentPath(touched)));
    const visible = this.#visible(tree);
    const wanted: string[] = [];
    for (const folder of folders) {
      if (!tree.open.has(folder)) continue;
      if (tree.visibility === 0) tree.stale.add(folder);
      else if (visible.has(folder)) wanted.push(folder);
    }
    if (wanted.length) this.#requestAll(tree, wanted, "first");
    if (wanted.length > 0) this.#scheduleStatusRefresh(tree);
  }

  #scheduleStatusRefresh(tree: TreeState): void {
    tree.statusRefresh?.();
    tree.statusRefresh = this.#timers.set(statusDelay, () => {
      tree.statusRefresh = undefined;
      if (tree.visibility > 0) this.#refreshStatus(tree);
    });
  }

  /** `files.watch`: the root and the visible open folders, sent once the set settles. */
  #scheduleWatch(tree: TreeState): void {
    tree.watch?.();
    tree.watch = undefined;
    if (tree.visibility === 0 || !("threadId" in tree.scope) || !this.#ready()) return;
    tree.watch = this.#timers.set(watchDelay, () => {
      tree.watch = undefined;
      if (tree.visibility === 0 || !this.#ready()) return;
      if (!("threadId" in tree.scope)) return;
      this.#sendWatch(tree, watchedFolders(this.#visible(tree)), tree.resendWatch);
      tree.resendWatch = false;
    });
  }

  #sendWatch(tree: TreeState, folders: string[], force = false): void {
    if (!("threadId" in tree.scope)) return;
    const joined = folders.join("\0");
    if (!force && joined === tree.watchSent) return;
    try {
      this.#owner.send({
        type: "files.watch",
        threadId: ThreadId.parse(tree.scope.threadId),
        folders,
      });
      tree.watchSent = joined;
    } catch {
      // A disconnect can race the send; the next socket sends the set again.
      tree.watchSent = undefined;
    }
  }

  #rememberHidden(tree: TreeState): void {
    this.#hidden.splice(0, this.#hidden.length, ...this.#hidden.filter((key) => key !== tree.key));
    this.#hidden.push(tree.key);
    while (this.#hidden.length > hiddenTreesKept) {
      const oldest = this.#hidden.shift();
      if (oldest === undefined) break;
      const dropped = this.#trees.get(oldest);
      if (dropped && dropped.visibility === 0) this.#prune(dropped);
    }
  }

  #forgetHidden(tree: TreeState): void {
    const at = this.#hidden.indexOf(tree.key);
    if (at >= 0) this.#hidden.splice(at, 1);
  }

  /** A long-hidden tree keeps what it knows about the screen, not the pages it listed. */
  #prune(tree: TreeState): void {
    tree.folders = {};
    tree.changes = [];
    tree.stale.clear();
    tree.refreshAll = true;
  }

  /** The rows the screen draws, built when the pump pulls the patch. */
  #emit(tree: TreeState): void {
    if (tree.visibility === 0) return;
    this.#sink.put(`files.tree:${tree.key}`, () => ({
      type: "files.tree",
      key: tree.key,
      rows: treeRows(tree.folders, tree.open, tree.changes),
    }));
  }
}
