import type { DatabaseSync } from "node:sqlite";
import type { WorkspaceId } from "@ace/protocol";
import { dueReads, markRead, saveRead } from "./project-remote-key.ts";

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
  /** Registrations read at once, per batch. */
  batch?: number;
  /** The pause before a sweep and between its batches, so it never crowds out other work. */
  pauseMs?: number;
}

/**
 * Keeps registrations' remote keys (ADR 0189) fresh in the background: `poke` starts a sweep
 * that reads, a few at a time with a pause between, every registration whose key is unread or
 * older than its TTL, and announces each whose key changed. Nothing runs until something pokes
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
    const batch = this.options.batch ?? 4;
    const pause = this.options.pauseMs ?? 250;
    // A registration whose read couldn't be kept stays due; it is read once per sweep.
    const seen = new Set<string>();
    for (;;) {
      await wait(pause);
      if (this.closed) return;
      const listed = atomic((db) => dueReads(db, now() - ttl, batch));
      const due = listed.filter((each) => !seen.has(each.workspaceId));
      if (!due.length) return;
      for (const each of due) seen.add(each.workspaceId);
      await Promise.all(
        due.map(async (each) => {
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
        }),
      );
      if (listed.length < batch) return;
    }
  }
}
