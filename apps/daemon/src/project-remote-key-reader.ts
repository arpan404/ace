import type { DatabaseSync } from "node:sqlite";
import type { WorkspaceId } from "@ace/protocol";
import { duePage, markRead, saveRead, type DueRead } from "./project-remote-key.ts";

/** What the reader needs of the daemon: its database, Git and a way to tell clients. */
export interface RemoteKeyReaderOptions {
  atomic<T>(work: (db: DatabaseSync) => T): T;
  /** A folder's remotes and subpath; undefined outside Git. As `@ace/git`'s `checkoutFacts`. */
  read(path: string): Promise<{ remotes: string[]; subpath: string } | undefined>;
  /** Tell clients a registration's reported key changed. */
  announce(workspaceId: WorkspaceId): void;
  now: () => number;
  /** Wait `ms` before going on; injected so tests decide when time passes. */
  wait(ms: number): Promise<void>;
  /** How long a read stays fresh. */
  ttlMs?: number;
  /** Registrations read from Git at once. */
  batch?: number;
  /** Registrations one page of the walk looks at. */
  pageSize?: number;
  /** The pause before a sweep and between its pages, so it never crowds out other work. */
  pauseMs?: number;
}

/**
 * Keeps registrations' remote keys (ADR 0189) fresh in the background: `poke` starts a sweep
 * that walks the registrations by id, one bounded page at a time with a pause between, reads
 * from Git (a few at once) each whose key is unread or older than its TTL, and announces each
 * whose key changed. Each page is a range read on the primary key (`duePage`), so no step of
 * the walk grows with the number of projects (ADR 0170). Nothing runs until something pokes
 * it (a client connecting, a project added), never at daemon open (ADR 0170). A poke during a
 * sweep runs one more sweep after it.
 */
export class RemoteKeyReader {
  private readonly options: RemoteKeyReaderOptions;
  private running: Promise<void> | undefined;
  private again = false;
  private closed = false;
  constructor(options: RemoteKeyReaderOptions) {
    this.options = options;
  }
  /** Read what is due, soon. Resolves when that sweep ends. */
  poke(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    // A sweep that fails (the database unreadable) ends quietly; the next poke tries again.
    const running = this.sweep()
      .catch(() => undefined)
      .finally(() => {
        this.running = undefined;
        if (this.again && !this.closed) {
          this.again = false;
          void this.poke();
        }
      });
    this.running = running;
    return running;
  }
  close(): void {
    this.closed = true;
  }
  private async sweep(): Promise<void> {
    const { atomic, now, wait } = this.options;
    const ttl = this.options.ttlMs ?? 600_000;
    const pageSize = this.options.pageSize ?? 64;
    let after: string | undefined = "";
    while (after !== undefined) {
      await wait(this.options.pauseMs ?? 250);
      if (this.closed) return;
      const cursor: string = after;
      const page = atomic((db) => duePage(db, cursor, now() - ttl, pageSize));
      after = page.next;
      await this.readAll(page.due);
    }
  }
  /** Read `due` from Git, `batch` at a time, keeping each result as it lands. */
  private async readAll(due: readonly DueRead[]): Promise<void> {
    let next = 0;
    const worker = async () => {
      while (!this.closed && next < due.length) {
        const each = due[next++];
        if (each) await this.readOne(each);
      }
    };
    const width = Math.min(this.options.batch ?? 4, due.length);
    await Promise.all(Array.from({ length: width }, worker));
  }
  private async readOne(each: DueRead): Promise<void> {
    const { atomic, now } = this.options;
    const found = await this.options.read(each.path).then(
      (facts) => facts ?? { remotes: [], subpath: "" },
      () => undefined,
    );
    if (this.closed) return;
    try {
      const changed = atomic((db) => {
        if (!found) {
          markRead(db, each.workspaceId, now());
          return false;
        }
        return saveRead(db, each, found, now());
      });
      // A registration kept apart reports no key, so its clients see no change.
      if (changed && !each.apart) this.options.announce(each.workspaceId);
    } catch {
      /* A full disk or a project removed meanwhile: the next sweep tries again. */
    }
  }
}
