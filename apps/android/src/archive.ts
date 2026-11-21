import type { ClientApi, ConnectionState, SidebarSource } from "@ace/client";
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
 * Shared coordination, scoped to the owning sidebar: the SDK applies
 * `threadsWindow` synchronously (`ClientCore` forwards straight to
 * `Sidebar.configure`), so the window the store shows is decided by the order
 * window calls are *issued*, not the order they settle. Every mount builds its
 * own `ArchivePaging`, but mounts on the same client share that client's
 * generation: each open or close claims it, and a session whose claim is no
 * longer current issues no further window calls and lets its late settlements
 * change nothing. The latest route's intent is therefore always the last window
 * call issued, even when older async calls complete out of order. No extra
 * leases or subscriptions are created here; coordination is window calls only.
 * Generations never cross clients: each canonical sidebar owns its own claim
 * series (see `archiveOwnerFor`), so archive work on one machine
 * cannot supersede another's.
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

export type ArchiveWindowPort = Pick<ClientApi, "threadsWindow" | "threadsMore" | "cachedThreads">;

/**
 * Stable explicit owner identity for one client's archive window. The
 * canonical sidebar (`cachedThreads()`, one `Sidebar` per `ClientCore`) is
 * the owner when the port exposes it, so two wrapper objects around the same
 * underlying client share one claim series. Ports without a cached sidebar
 * (stubs, closed clients) fall back to their own identity: each such port is
 * its own owner. Callers must forward `cachedThreads` when wrapping a client;
 * a wrapper that hides it is treated as a separate owner.
 */
export function archiveOwnerFor(port: ArchiveWindowPort): object {
  try {
    const store = port.cachedThreads?.();
    if (store) return store;
  } catch {
    // A closed client has no cached sidebar; fall through to port identity.
  }
  return port;
}

/**
 * One claim series per canonical owner. Entries live as long as their owner:
 * a `WeakMap` so heal polling and removed/re-paired clients never leak.
 */
interface WindowCoordination {
  generation: number;
  archiveWanted: boolean;
}

let windowCoordinations = new WeakMap<object, WindowCoordination>();

function coordinationFor(port: ArchiveWindowPort): WindowCoordination {
  const owner = archiveOwnerFor(port);
  let coord = windowCoordinations.get(owner);
  if (!coord) {
    coord = { generation: 0, archiveWanted: false };
    windowCoordinations.set(owner, coord);
  }
  return coord;
}

/** Read-only peek: heals and `wanted` checks must not mint entries. */
function coordinationPeek(port: ArchiveWindowPort): WindowCoordination | undefined {
  return windowCoordinations.get(archiveOwnerFor(port));
}

/**
 * Whether the latest route on this owner currently wants the archive window.
 * Takes the port but resolves to the canonical owner, so two wrappers around
 * the same client answer together. Never mints coordination entries.
 */
export function isArchiveWindowWanted(port: ArchiveWindowPort): boolean {
  return coordinationPeek(port)?.archiveWanted ?? false;
}

/**
 * Reset the shared window coordination. Tests only: pass a port to reset
 * only that owner's series; with no port every series is dropped (the map is
 * replaced, so stale owners are collectible). Production holds one client
 * per machine for the app lifetime.
 */
export function resetArchiveWindowCoordinationForTests(port?: ArchiveWindowPort): void {
  if (port) windowCoordinations.delete(archiveOwnerFor(port));
  else windowCoordinations = new WeakMap();
}

/**
 * Best-effort home heal for screens mounted without the archive (the inbox
 * self-heal). Never repoints home while an archive route on the same owner
 * wants the window, and never bumps the generation: it is the same direction
 * as a close, so it cannot strand or supersede anyone. Failures stay silent;
 * the next window call repairs them. Resolves the canonical owner first, so a
 * heal through one wrapper yields to an archive opened through another.
 */
export function requestHomeWindow(port: ArchiveWindowPort): void {
  if (coordinationPeek(port)?.archiveWanted) return;
  void port.threadsWindow({}).catch(() => {});
}

/**
 * Reconnect/focus recovery for a stranded home window (a failed archive
 * restore left the shared store on the archive filter while no archive route
 * owns it). Repoints home only when the connection is ready and only when no
 * archive route on the same owner wants the window, so a heal never clobbers
 * an open archive. Failures stay silent; the next heal retries them.
 */
export function recoverStrandedHomeWindow(
  port: ArchiveWindowPort,
  connection: ConnectionState | undefined,
): void {
  if (connection !== "ready") return;
  requestHomeWindow(port);
}

/**
 * The archive window lifecycle with a guarded pager. A fast scroll or a double tap
 * asks for one page at a time; a page that lands after close changes nothing (the
 * close claims the client's generation, invalidating it, mirroring the iOS bridge's
 * `#visit`). Mounts on the same client share that client's generation: a close or
 * retry superseded by a reopen issues no home call that could clobber the new
 * archive window, and reports itself superseded (true with `superseded`) instead
 * of failed so the old screen surfaces no strand notice. A superseded close is
 * success from the inbox's view: the new route already owns the window, so there
 * is nothing stranded to report. Only this session's own failed restore returns
 * false. The shared sidebar store is single-instance per client
 * (`client.threads()` leases share one `Sidebar`): opening the archive repoints
 * it, so closing must repoint it home before the lease drops, and a failed
 * restore is reported, not swallowed.
 */
export class ArchivePaging {
  /** The generation this session's last window intent claimed; 0 when it owns none. */
  private claim = 0;
  /** Which canonical owner's generation `claim` belongs to; claims never cross owners. */
  private claimOwner: object | null = null;
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
   * claimed the window while it was in flight). A superseded close reports
   * success (true): the new route owns the window, so there is no strand to
   * report.
   */
  get superseded(): boolean {
    return this.stale;
  }

  /** Whether this session still owns the latest window intent for this owner. */
  private ownsWindow(port: ArchiveWindowPort): boolean {
    if (this.claimOwner === null || this.claim === 0) return false;
    if (this.claimOwner !== archiveOwnerFor(port)) return false;
    return this.claim === coordinationPeek(port)?.generation;
  }

  /**
   * Whether the window call that claimed `claim` on `port` is still the latest
   * intent: neither this session nor another one on the same owner claimed a
   * newer window since. A captured claim is needed next to the stored one: a
   * same-instance reopen overwrites `claim`, so the stored check alone would
   * bless the stale call. The owner check keeps one client's reopen from
   * validating another client's stale call, and lets two wrappers around the
   * same sidebar validate each other.
   */
  private current(port: ArchiveWindowPort, claim: number): boolean {
    return (
      this.claimOwner === archiveOwnerFor(port) &&
      this.claim === claim &&
      claim === coordinationPeek(port)?.generation
    );
  }

  /**
   * Follow this machine's archive window. A rejected window read fails openly.
   * Returns false when a newer open or close invalidated this attempt, so a
   * late settlement never touches the new session's flags.
   */
  async openArchive(port: ArchiveWindowPort): Promise<boolean> {
    const coord = coordinationFor(port);
    const claim = ++coord.generation;
    coord.archiveWanted = true;
    this.claim = claim;
    this.claimOwner = archiveOwnerFor(port);
    this.stale = false;
    this.opened = true;
    this.failed = false;
    this.restoreFailed = false;
    try {
      await port.threadsWindow({ archived: true });
      if (!this.current(port, claim)) {
        this.stale = true;
        return false;
      }
      this.stale = false;
      return true;
    } catch {
      if (!this.current(port, claim)) {
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
    const generation = coordinationFor(port).generation;
    this.loading = true;
    this.failed = false;
    try {
      await port.threadsMore();
      if (coordinationPeek(port)?.generation !== generation) {
        this.stale = true;
        this.loading = false;
        return false;
      }
      this.loading = false;
      return true;
    } catch {
      if (coordinationPeek(port)?.generation !== generation) {
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
   * Returns true when the shared store is repointed home, when there was
   * nothing to restore, or when a newer route on the same client superseded
   * this close (the new route owns the window, so no strand notice). Returns
   * false only when this session's own restore failed, so the inbox underneath
   * does not silently stay on the archive window until the next window call. A
   * close that loses to a newer open or close issues no home call that could
   * clobber the new session's archive window and leaves the new session's
   * flags alone.
   */
  async closeArchive(port: ArchiveWindowPort): Promise<boolean> {
    if (!this.opened) return true;
    const coord = coordinationFor(port);
    if (!this.ownsWindow(port) || !coord.archiveWanted) {
      this.opened = false;
      this.loading = false;
      this.failed = false;
      this.claim = 0;
      this.claimOwner = null;
      this.stale = true;
      return true;
    }
    const claim = ++coord.generation;
    coord.archiveWanted = false;
    this.claim = claim;
    this.claimOwner = archiveOwnerFor(port);
    this.stale = false;
    this.opened = false;
    this.loading = false;
    this.failed = false;
    try {
      await port.threadsWindow({});
      if (!this.current(port, claim)) {
        this.claim = 0;
        this.claimOwner = null;
        this.stale = true;
        return true;
      }
      this.claim = 0;
      this.claimOwner = null;
      this.restoreFailed = false;
      return true;
    } catch (error) {
      if (!this.current(port, claim)) {
        this.claim = 0;
        this.claimOwner = null;
        this.stale = true;
        return true;
      }
      this.restoreFailed = true;
      console.warn("AceArchiveRestore", error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /**
   * Best-effort home restore that does not strand the inbox on the archive window:
   * up to `attempts` home-window calls before reporting failure. The shared sidebar
   * is single-instance per client, so every attempt repoints the same store the
   * inbox reads. A newer open or close on the same client invalidates the retry
   * before the next attempt: it returns true superseded without touching the new
   * session's flags or issuing a home call past the new session's archive window.
   * Returns false only when this session's own restore failed on every attempt.
   */
  async closeArchiveWithRetry(port: ArchiveWindowPort, attempts = 3): Promise<boolean> {
    if (!this.opened && !this.restoreFailed) return true;
    const coord = coordinationFor(port);
    // Proceed while this session is the latest owner: either its archive open is
    // still the latest intent, or its own failed restore is (retrying it). A newer
    // open owns the window instead, and there is nothing to restore.
    if (!this.ownsWindow(port) || (coord.archiveWanted && !this.opened)) {
      this.opened = false;
      this.loading = false;
      this.failed = false;
      this.restoreFailed = false;
      this.claim = 0;
      this.claimOwner = null;
      this.stale = true;
      return true;
    }
    const claim = ++coord.generation;
    coord.archiveWanted = false;
    this.claim = claim;
    this.claimOwner = archiveOwnerFor(port);
    this.stale = false;
    this.opened = false;
    this.loading = false;
    this.failed = false;
    const tries = Math.max(1, Math.floor(attempts));
    for (let attempt = 0; attempt < tries; attempt++) {
      if (!this.current(port, claim) || coordinationPeek(port)?.archiveWanted) {
        this.claim = 0;
        this.claimOwner = null;
        this.stale = true;
        return true;
      }
      try {
        await port.threadsWindow({});
        if (!this.current(port, claim)) {
          this.claim = 0;
          this.claimOwner = null;
          this.stale = true;
          return true;
        }
        this.claim = 0;
        this.claimOwner = null;
        this.restoreFailed = false;
        return true;
      } catch (error) {
        if (!this.current(port, claim)) {
          this.claim = 0;
          this.claimOwner = null;
          this.stale = true;
          return true;
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
