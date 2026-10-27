import type { ClientApi, SidebarSource } from "@ace/client";
import type { ThreadListEntry } from "@ace/protocol";
import { archivedOrder } from "@ace/ui-core/mobile";

/*
 * Android archive browser (parity slice A04.04): one machine's archived threads, most
 * recently archived first, paged 20 at a time through the SDK's archive window, mirroring
 * the iOS bridge (`apps/ios/bridge/archive.ts`) and browser
 * (`Sources/Models/ArchiveBrowser.swift`). Rows travel as inbox rows from the shared
 * store; this module owns only the order, the paging state and the window lifecycle.
 *
 * Single-machine scope: this phone holds one SDK sidebar, so opening the archive
 * repoints the shared store at the archive window while the screen is mounted (the
 * home list underneath regroups to empty because `arrange` hides archived rows) and
 * closing returns it to the home window. A second machine's subscription is never
 * touched because this phone owns only its own window calls.
 */

/** The most archived rows one list carries; older pages past this stay on the machine. */
export const archiveListLimit = 1000;

export interface ArchiveListState {
  open: boolean;
  ids: string[];
  more: boolean;
  loaded: boolean;
  loading: boolean;
  failed: boolean;
  /** The store is still catching up to the daemon; rows may be a disk copy. */
  syncing: boolean;
  /** The store's own failure code, when the window itself is rejected. */
  errorCode?: string | undefined;
}

export function closedArchiveList(): ArchiveListState {
  return {
    open: false,
    ids: [],
    more: false,
    loaded: false,
    loading: false,
    failed: false,
    syncing: false,
    errorCode: undefined,
  };
}

type ArchiveStore = Pick<SidebarSource, "ids" | "thread" | "window" | "loaded"> &
  Partial<Pick<SidebarSource, "syncing" | "unconfirmed" | "error">>;

/**
 * The archived rows the store holds, most recently archived first. Reads at delivery:
 * a page of twenty rows costs one ordering.
 */
export function orderedArchiveIds(store: Pick<SidebarSource, "ids" | "thread">): string[] {
  const entries: ThreadListEntry[] = [];
  for (const id of store.ids) {
    const entry = store.thread(id);
    if (entry) entries.push(entry);
  }
  return archivedOrder(entries, { project: null });
}

export function archiveIds(
  store: Pick<SidebarSource, "ids" | "thread">,
  limit: number = archiveListLimit,
): string[] {
  return orderedArchiveIds(store).slice(0, limit);
}

/** Whether the daemon holds an older archive page past the rows on this phone. */
export function archiveHasMore(store: Pick<SidebarSource, "window">, totalListed: number): boolean {
  return store.window?.before != null || totalListed > archiveListLimit;
}

export function readArchiveList(
  store: ArchiveStore,
  loading: boolean,
  failed: boolean,
): ArchiveListState {
  const ordered = orderedArchiveIds(store);
  return {
    open: true,
    ids: ordered.slice(0, archiveListLimit),
    more: archiveHasMore(store, ordered.length),
    loaded: store.loaded,
    loading,
    failed,
    syncing: store.syncing ?? false,
    errorCode: store.error?.code,
  };
}

/**
 * Whether the footer may claim to be loading. A failed window must never read as
 * loading: after a rejection `loading` is false but the store is still unloaded on a
 * ready connection, which the old `loading || (!loaded && ready)` spinner masked as
 * "Loading…" instead of offering the retry. Failed wins; the spinner covers only a
 * load actually in flight or an initial window still on its way.
 */
export function archiveFooterKind(
  list: Pick<ArchiveListState, "loading" | "failed" | "loaded" | "ids" | "more">,
  connection: string,
): "loading" | "failed" | "offline" | "empty" | "more" | "none" {
  if (list.loading) return "loading";
  if (list.failed) return "failed";
  if (!list.loaded) return connection === "ready" ? "loading" : "offline";
  if (list.ids.length === 0) return "empty";
  if (list.more) return "more";
  return "none";
}

/**
 * Whether a live (non-archived) thread may show its composer. Archived threads always
 * show the ArchivedNote; a view-only phone (`canAct` anything but explicit `true`)
 * shows the read-only note instead of an unguarded composer, mirroring iOS
 * `ThreadView` (`canOperate ? ComposerView : ViewOnlyNote.thread`).
 */
export function canComposeLive(canAct: boolean | undefined, archived: boolean): boolean {
  if (archived) return false;
  return canAct === true;
}

/** Whether an older-page request may start: one page at a time, only while one exists. */
export function canPageArchive(more: boolean, loading: boolean): boolean {
  return more && !loading;
}

export type ArchiveWindowPort = Pick<ClientApi, "threadsWindow" | "threadsMore">;

/**
 * The archive window lifecycle with a guarded pager. A fast scroll or a double tap
 * asks for one page at a time; a page that lands after close changes nothing (the
 * visit bump on open and close invalidates it, mirroring the iOS bridge's `#visit`).
 * The shared sidebar store is single-instance (`client.threads()` leases share one
 * `Sidebar`): opening the archive repoints it, so closing must repoint it home
 * before the lease drops, and a failed restore is reported, not swallowed.
 */
export class ArchivePaging {
  private visit = 0;
  private opened = false;
  loading = false;
  failed = false;
  /** True when the last home-window restore failed; cleared on the next open. */
  restoreFailed = false;

  get open(): boolean {
    return this.opened;
  }

  /**
   * Follow this machine's archive window. A rejected window read fails openly.
   * Returns false when a newer open or close invalidated this attempt, so a
   * late settlement never touches the new session's flags.
   */
  async openArchive(port: ArchiveWindowPort): Promise<boolean> {
    const visit = ++this.visit;
    this.opened = true;
    this.failed = false;
    this.restoreFailed = false;
    try {
      await port.threadsWindow({ archived: true });
      if (visit !== this.visit) return false;
      return true;
    } catch {
      if (visit !== this.visit) return false;
      this.failed = true;
      return true;
    }
  }

  /**
   * Ask for the next 20 archived threads; false when one is already on its way
   * or none remains. A rejection fails openly so the footer can offer a retry.
   */
  async loadMore(port: ArchiveWindowPort, hasMore: boolean): Promise<boolean> {
    if (!canPageArchive(hasMore, this.loading)) return false;
    const visit = this.visit;
    this.loading = true;
    this.failed = false;
    try {
      await port.threadsMore();
      if (visit === this.visit) this.loading = false;
      return visit === this.visit;
    } catch {
      if (visit === this.visit) {
        this.loading = false;
        this.failed = true;
      }
      return false;
    }
  }

  /** Back to the home window; the archived rows leave this phone's store.
   * Returns true when the shared store is repointed home. A failed restore
   * returns false and is logged, so the inbox underneath does not silently
   * stay on the archive window until the next window call. A close that loses
   * to a newer open or close leaves the new session's flags alone and reports
   * false, so its late settlement never clears the new session or repoints a
   * store the new session just moved to the archive window.
   */
  async closeArchive(port: ArchiveWindowPort): Promise<boolean> {
    if (!this.opened) return true;
    const visit = ++this.visit;
    this.opened = false;
    this.loading = false;
    this.failed = false;
    try {
      await port.threadsWindow({});
      if (visit !== this.visit) return false;
      this.restoreFailed = false;
      return true;
    } catch (error) {
      if (visit !== this.visit) return false;
      this.restoreFailed = true;
      console.warn("AceArchiveRestore", error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /**
   * Best-effort home restore that does not strand the inbox on the archive window:
   * up to `attempts` home-window calls before reporting failure. The shared sidebar
   * is single-instance, so every attempt repoints the same store the inbox reads.
   * A newer open or close invalidates the retry: it returns false without touching
   * the new session's flags.
   */
  async closeArchiveWithRetry(port: ArchiveWindowPort, attempts = 3): Promise<boolean> {
    if (!this.opened && !this.restoreFailed) return true;
    const visit = ++this.visit;
    this.opened = false;
    this.loading = false;
    this.failed = false;
    const tries = Math.max(1, Math.floor(attempts));
    for (let attempt = 0; attempt < tries; attempt++) {
      try {
        await port.threadsWindow({});
        if (visit !== this.visit) return false;
        this.restoreFailed = false;
        return true;
      } catch (error) {
        if (visit !== this.visit) return false;
        if (attempt + 1 >= tries) {
          this.restoreFailed = true;
          console.warn("AceArchiveRestore", error instanceof Error ? error.message : String(error));
          return false;
        }
      }
    }
    return false;
  }
}
