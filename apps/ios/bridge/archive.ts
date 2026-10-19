import type { ClientCore, Lease, SidebarSource } from "@ace/client";
import type { ThreadListEntry } from "@ace/protocol";
import { archivedOrder } from "@ace/ui-core/mobile";
import { z } from "zod";
import type { PatchSink } from "./agents.ts";

/*
 * The archive browser: one machine's archived threads, most recently archived first, paged 20
 * at a time by the SDK's archive window (as the web's Archived screen pages). Rows themselves
 * travel as `inbox.row` from the inbox follower, which sees every thread the store holds; this
 * sends only the order and the paging state. Closing returns the store to the home window.
 */

export const ArchiveAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("open") }),
  z.object({ kind: z.literal("more") }),
  z.object({ kind: z.literal("close") }),
]);
export type ArchiveAction = z.infer<typeof ArchiveAction>;

export type ArchiveOwner = Pick<ClientCore, "threads" | "threadsWindow" | "threadsMore">;

/** The most archived rows one list carries; older pages past this stay on the computer. */
export const archiveListLimit = 1000;

export class ArchiveBrowser {
  #owner: ArchiveOwner;
  #sink: PatchSink;
  #lease: Lease<SidebarSource> | undefined;
  #stop: (() => void) | undefined;
  #loading = false;
  #failed = false;
  /** Bumped on every open and close, so a page that lands after close changes nothing. */
  #visit = 0;

  constructor(owner: ArchiveOwner, sink: PatchSink) {
    this.#owner = owner;
    this.#sink = sink;
  }

  handle(raw: unknown): boolean {
    const parsed = ArchiveAction.safeParse(raw);
    if (!parsed.success) return false;
    switch (parsed.data.kind) {
      case "open":
        this.#open();
        return true;
      case "more":
        this.#more();
        return true;
      case "close":
        this.close();
        return true;
    }
  }

  close(): void {
    if (!this.#lease) return;
    this.#visit++;
    this.#stop?.();
    this.#stop = undefined;
    this.#lease.release();
    this.#lease = undefined;
    this.#loading = false;
    this.#failed = false;
    void this.#owner.threadsWindow({}).catch(() => {});
    this.#sink.put("archive:list", () => ({ type: "archive.list", open: false }));
  }

  #open(): void {
    if (this.#lease) {
      this.#list();
      return;
    }
    this.#visit++;
    this.#lease = this.#owner.threads();
    const store = this.#lease.store;
    this.#stop = store.observe(() => this.#list());
    void this.#owner.threadsWindow({ archived: true }).catch(() => {
      this.#failed = true;
      this.#list();
    });
    this.#list();
  }

  #more(): void {
    const store = this.#lease?.store;
    if (!store || this.#loading || store.window?.before == null) return;
    const visit = this.#visit;
    this.#loading = true;
    this.#failed = false;
    this.#list();
    this.#owner.threadsMore().then(
      () => this.#settle(visit, false),
      () => this.#settle(visit, true),
    );
  }

  #settle(visit: number, failed: boolean): void {
    if (visit !== this.#visit) return;
    this.#loading = false;
    this.#failed = failed;
    this.#list();
  }

  /** Read at delivery: a page of twenty rows costs one ordering. */
  #list(): void {
    const store = this.#lease?.store;
    if (!store) return;
    this.#sink.put("archive:list", () => {
      const entries: ThreadListEntry[] = [];
      for (const id of store.ids) {
        const entry = store.thread(id);
        if (entry) entries.push(entry);
      }
      const ids = archivedOrder(entries, { project: null });
      return {
        type: "archive.list",
        open: true,
        ids: ids.slice(0, archiveListLimit),
        more: store.window?.before != null || ids.length > archiveListLimit,
        loaded: store.loaded,
        loading: this.#loading,
        failed: this.#failed,
      };
    });
  }
}
