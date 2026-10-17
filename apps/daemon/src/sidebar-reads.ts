import type { StatementSync } from "node:sqlite";
import { BoundedCache } from "@ace/provider-kit/bounded-cache";
import { sidebarPageStorage } from "./sidebar-page-storage.ts";
import { SidebarPageWeight } from "./sidebar-page-weight.ts";
import { decodeThreadRow } from "./thread-row.ts";
interface SidebarReadSource {
  statement(sql: string): StatementSync;
  /** Store-owned SQLite snapshot; SidebarReads owns only its caches. */
  snapshot<T>(read: () => T): T;
}
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
  constructor(source: SidebarReadSource) {
    this.source = source;
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
    try {
      return this.source.snapshot(() => this.loadSidebarPage(options, before, reuse));
    } catch (error) {
      this.sidebarPages.clear();
      this.sidebarSummaries.clear();
      throw error;
    }
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
        const entry = decodeThreadRow(row);
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
