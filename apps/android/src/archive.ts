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
 *
 * Shared coordination: the SDK applies `threadsWindow` synchronously (`ClientCore`
 * forwards straight to `Sidebar.configure`), so the window the store shows is
 * decided by the order window calls are *issued*, not the order they settle. Every
 * mount builds its own `ArchivePaging`, but mounts share this module's generation:
 * each open or close claims it, and a session whose claim is no longer current
 * issues no further window calls and lets its late settlements change nothing. The
 * latest route's intent is therefore always the last window call issued, even when
 * older async calls complete out of order. No extra leases or subscriptions are
 * created here; coordination is window calls only.
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
 * The shared window generation. Every archive open or home restore claims it
 * synchronously before its first await, so the claim order matches the route
 * order even when the calls themselves settle late or out of order.
 */
let windowGeneration = 0;
/** Whether the latest route wants the archive window (false: home). */
let archiveWindowWanted = false;

/** Whether the latest route owns the archive window right now. */
export function isArchiveWindowWanted(): boolean {
  return archiveWindowWanted;
}

/**
 * Reset the shared window coordination. Tests only: each test starts from no
 * owner so one test's open/close cannot gate another's.
 */
export function resetArchiveWindowCoordinationForTests(): void {
  windowGeneration = 0;
  archiveWindowWanted = false;
}

/**
 * Best-effort home heal for screens mounted without the archive (the inbox
 * self-heal). Never repoints home while an archive route owns the window, and
 * never bumps the generation: it is the same direction as a close, so it
 * cannot strand or supersede anyone. Failures stay silent; the next window
 * call repairs them.
 */
export function requestHomeWindow(port: ArchiveWindowPort): void {
  if (archiveWindowWanted) return;
  void port.threadsWindow({}).catch(() => {});
}

/**
 * The archive window lifecycle with a guarded pager. A fast scroll or a double tap
 * asks for one page at a time; a page that lands after close changes nothing (the
 * close claims the shared generation, invalidating it, mirroring the iOS bridge's
 * `#visit`). Mounts share the generation: a close or retry superseded by a reopen
 * issues no home call that could clobber the new archive window, and reports
 * itself superseded instead of failed so the old screen surfaces no strand notice.
 * The shared sidebar store is single-instance (`client.threads()` leases share one
 * `Sidebar`): opening the archive repoints it, so closing must repoint it home
 * before the lease drops, and a failed restore is reported, not swallowed.
 */
export class ArchivePaging {
  /** The generation this session's last window intent claimed; 0 when it owns none. */
  private claim = 0;
  /** True once a settlement lost to a newer route; cleared by the next own intent. */
  private stale = false;
  private opened = false;
  loading = false;
  failed = false;
  /** True when the last home-window restore failed; cleared on the next open. */
  restoreFailed = false;

  get open(): boolean {
    return this.opened;
  }

  /**
   * True when this session's last window call lost to a newer route (a reopen
   * claimed the window while it was in flight). The caller must not surface a
   * strand notice for a superseded restore: the new route owns the window.
   */
  get superseded(): boolean {
    return this.stale;
  }

  /** Whether this session still owns the latest window intent. */
  private ownsWindow(): boolean {
    return this.claim !== 0 && this.claim === windowGeneration;
  }

  /**
   * Whether the window call that claimed `claim` is still the latest intent:
   * neither this session nor another one claimed a newer window since. A
   * captured claim is needed next to the stored one: a same-instance reopen
   * overwrites `claim`, so the stored check alone would bless the stale call.
   */
  private current(claim: number): boolean {
    return this.claim === claim && claim === windowGeneration;
  }

  /**
   * Follow this machine's archive window. A rejected window read fails openly.
   * Returns false when a newer open or close invalidated this attempt, so a
   * late settlement never touches the new session's flags.
   */
  async openArchive(port: ArchiveWindowPort): Promise<boolean> {
    const claim = ++windowGeneration;
    archiveWindowWanted = true;
    this.claim = claim;
    this.stale = false;
    this.opened = true;
    this.failed = false;
    this.restoreFailed = false;
    try {
      await port.threadsWindow({ archived: true });
      if (!this.current(claim)) {
        this.stale = true;
        return false;
      }
      this.stale = false;
      return true;
    } catch {
      if (!this.current(claim)) {
        this.stale = true;
        return false;
      }
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
    const generation = windowGeneration;
    this.loading = true;
    this.failed = false;
    try {
      await port.threadsMore();
      if (generation !== windowGeneration) {
        this.stale = true;
        this.loading = false;
        return false;
      }
      this.loading = false;
      return true;
    } catch {
      if (generation !== windowGeneration) {
        this.stale = true;
        this.loading = false;
        return false;
      }
      this.loading = false;
      this.failed = true;
      return false;
    }
  }

  /** Back to the home window; the archived rows leave this phone's store.
   * Returns true when the shared store is repointed home. A failed restore
   * returns false and is logged, so the inbox underneath does not silently
   * stay on the archive window until the next window call. A close that loses
   * to a newer open or close issues no home call that could clobber the new
   * session's archive window, leaves the new session's flags alone, and reports
   * itself superseded (false with `superseded`), so its late settlement never
   * clears the new session or surfaces a strand notice for a window the new
   * route owns.
   */
  async closeArchive(port: ArchiveWindowPort): Promise<boolean> {
    if (!this.opened) return true;
    if (!this.ownsWindow() || !archiveWindowWanted) {
      this.opened = false;
      this.loading = false;
      this.failed = false;
      this.claim = 0;
      this.stale = true;
      return false;
    }
    const claim = ++windowGeneration;
    archiveWindowWanted = false;
    this.claim = claim;
    this.stale = false;
    this.opened = false;
    this.loading = false;
    this.failed = false;
    try {
      await port.threadsWindow({});
      if (!this.current(claim)) {
        this.claim = 0;
        this.stale = true;
        return false;
      }
      this.claim = 0;
      this.restoreFailed = false;
      return true;
    } catch (error) {
      if (!this.current(claim)) {
        this.claim = 0;
        this.stale = true;
        return false;
      }
      this.restoreFailed = true;
      console.warn("AceArchiveRestore", error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /**
   * Best-effort home restore that does not strand the inbox on the archive window:
   * up to `attempts` home-window calls before reporting failure. The shared sidebar
   * is single-instance, so every attempt repoints the same store the inbox reads.
   * A newer open or close invalidates the retry before the next attempt: it returns
   * false superseded without touching the new session's flags or issuing a home
   * call past the new session's archive window.
   */
  async closeArchiveWithRetry(port: ArchiveWindowPort, attempts = 3): Promise<boolean> {
    if (!this.opened && !this.restoreFailed) return true;
    // Proceed while this session is the latest owner: either its archive open is
    // still the latest intent, or its own failed restore is (retrying it). A newer
    // open owns the window instead, and there is nothing to restore.
    if (!this.ownsWindow() || (archiveWindowWanted && !this.opened)) {
      this.opened = false;
      this.loading = false;
      this.failed = false;
      this.restoreFailed = false;
      this.claim = 0;
      this.stale = true;
      return false;
    }
    const claim = ++windowGeneration;
    archiveWindowWanted = false;
    this.claim = claim;
    this.stale = false;
    this.opened = false;
    this.loading = false;
    this.failed = false;
    const tries = Math.max(1, Math.floor(attempts));
    for (let attempt = 0; attempt < tries; attempt++) {
      if (!this.current(claim) || archiveWindowWanted) {
        this.claim = 0;
        this.stale = true;
        return false;
      }
      try {
        await port.threadsWindow({});
        if (!this.current(claim)) {
          this.claim = 0;
          this.stale = true;
          return false;
        }
        this.claim = 0;
        this.restoreFailed = false;
        return true;
      } catch (error) {
        if (!this.current(claim)) {
          this.claim = 0;
          this.stale = true;
          return false;
        }
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
