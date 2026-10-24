import type { SQLOutputValue, StatementSync } from "node:sqlite";
import { BoundedCache } from "@ace/provider-kit/bounded-cache";
import { sidebarCursor, sidebarPageStorage } from "./sidebar-page-storage.ts";
import { SidebarLive } from "./sidebar-live.ts";
import { SidebarPageWeight } from "./sidebar-page-weight.ts";
import type { Thread, ThreadListEntry, ThreadListWindow } from "@ace/protocol";
import type { FrozenThread } from "./thread-cache.ts";
interface SidebarReadSource {
  statement(sql: string): StatementSync;
  /** Store-owned SQLite snapshot; SidebarReads owns only its caches. */
  snapshot<T>(read: () => T): T;
  /** Shared, frozen decode of a row read with its revision. Entries are only sent, never changed. */
  decode(row: Record<string, SQLOutputValue>, revision: SQLOutputValue | undefined): FrozenThread;
  /** The thread's current row, shared and frozen. */
  read(id: string): FrozenThread | undefined;
  /** No write is open on the connection, so a snapshot opened now holds committed data only. */
  committed(): boolean;
}
type Reuse = {
  entries: ReadonlyMap<string, ThreadListEntry>;
  changed: ReadonlySet<string>;
};
type SidebarOptions = {
  limit: number;
  project?: string | undefined;
  archived?: boolean | undefined;
};
/** Sidebar reads pin membership and payloads to one SQLite snapshot and revision. */
export class SidebarReads {
  private sidebarRevision = "";
  private readonly sidebarPageWeight = new SidebarPageWeight();
  private readonly sidebarRowRevisions = new WeakMap<
    import("@ace/protocol").ThreadListEntry,
    number
  >();
  private readonly sidebarPages = new BoundedCache<string, ReturnType<typeof sidebarPageStorage>>(
    16,
    4 * 1024 * 1024,
  );
  private readonly sidebarSummaries = new BoundedCache<
    string,
    Pick<import("@ace/protocol").ThreadListWindow, "total" | "counts">
  >(16, 256 * 1024);
  private readonly source: SidebarReadSource;
  private readonly live: SidebarLive;
  constructor(source: SidebarReadSource) {
    this.source = source;
    this.live = new SidebarLive((sql) => source.statement(sql));
  }
  invalidate(): void {
    this.sidebarPages.clear();
    this.sidebarSummaries.clear();
  }
  sidebarPage(
    options: { limit: number; project?: string | undefined; archived?: boolean | undefined },
    before?: import("@ace/protocol").ThreadListCursor,
    reuse?: {
      entries: ReadonlyMap<string, import("@ace/protocol").ThreadListEntry>;
      changed: ReadonlySet<string>;
    },
  ) {
    // A live window update reads the index; anything else, or a read inside an open write
    // (whose rows a rollback could still undo), takes the full SQL read.
    if (reuse && !before && this.source.committed())
      try {
        return this.source.snapshot(() => this.liveWindow(options, reuse));
      } catch (error) {
        this.live.reset();
        throw error;
      }
    try {
      return this.source.snapshot(() => this.loadSidebarPage(options, before, reuse));
    } catch (error) {
      this.sidebarPages.clear();
      this.sidebarSummaries.clear();
      throw error;
    }
  }
  /** The window from the index: work for the rows changed since the last sync and the window. */
  private liveWindow(
    options: SidebarOptions,
    reuse: Reuse,
  ): { threads: ThreadListEntry[]; window: ThreadListWindow } {
    this.live.sync();
    const ids = this.live.index.window(options, options.limit);
    const entry = (id: string): ThreadListEntry => {
      const revision = this.live.index.revision(id);
      const retained = reuse.entries.get(id);
      if (
        retained &&
        !reuse.changed.has(id) &&
        revision !== undefined &&
        this.sidebarRowRevisions.get(retained) === revision
      )
        return retained;
      // Frozen at runtime; the wire types are mutable only because they are plain schemas.
      const thread = this.source.read(id) as Thread | undefined;
      if (!thread) throw new Error("Sidebar membership changed within a read");
      if (revision !== undefined) this.sidebarRowRevisions.set(thread, revision);
      return thread;
    };
    const active = ids.active.map(entry);
    const page = ids.page.map(entry);
    const last = page.at(-1);
    return {
      threads: [...active, ...page],
      window: {
        before: ids.more && last ? sidebarCursor(last, options.archived) : null,
        total: ids.total,
        counts: ids.counts,
      },
    };
  }
  private loadSidebarPage(
    options: { limit: number; project?: string | undefined; archived?: boolean | undefined },
    before?: import("@ace/protocol").ThreadListCursor,
    reuse?: {
      entries: ReadonlyMap<string, import("@ace/protocol").ThreadListEntry>;
      changed: ReadonlySet<string>;
    },
  ) {
    // Covers direct writes through atomic(), including imports and rollback invalidation.
    const revisionRow = this.source
      .statement(
        "SELECT total_changes() AS writes, (SELECT data_version FROM pragma_data_version) AS external, (SELECT revision FROM sidebar_thread_revisions LIMIT 1) AS snapshot_anchor",
      )
      .get();
    const revision = `${revisionRow?.writes}:${revisionRow?.external}`;
    if (revision !== this.sidebarRevision) {
      this.sidebarPages.clear();
      this.sidebarSummaries.clear();
      this.sidebarRevision = revision;
    }
    const key = JSON.stringify([
      options.limit,
      options.project ?? null,
      options.archived === true,
      before ?? null,
    ]);
    const cached = this.sidebarPages.get(key);
    if (cached) return cached;
    const page = sidebarPageStorage(
      (sql) => this.source.statement(sql),
      (row) => {
        // Frozen at runtime; the wire types are mutable only because they are plain schemas.
        const entry = this.source.decode(row, row.sidebar_revision) as Thread;
        this.sidebarRowRevisions.set(entry, Number(row.sidebar_revision));
        return entry;
      },
      options,
      before,
      reuse
        ? {
            ...reuse,
            current: (entry, rowRevision) => this.sidebarRowRevisions.get(entry) === rowRevision,
          }
        : undefined,
      (load) => {
        const summaryKey = JSON.stringify([options.project ?? null, options.archived === true]);
        const summaryHit = this.sidebarSummaries.get(summaryKey);
        if (summaryHit) return summaryHit;
        const summary = load();
        this.sidebarSummaries.set(summaryKey, summary, Buffer.byteLength(JSON.stringify(summary)));
        return summary;
      },
    );
    this.sidebarPages.set(key, page, this.sidebarPageWeight.bytes(page));
    return page;
  }
}
