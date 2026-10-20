import type { ReadSnapshotStorage } from "./read-snapshot-storage.ts";

/**
 * A client's read snapshots filed under the daemon that served them (ADR 0030). Records are
 * read only once the daemon's identity is known (pinned, bound in an earlier session, or the
 * first welcome) and only under that identity, so a daemon started afresh at the same address
 * (a new host id) never paints the threads of the one it replaced. Until then nothing is
 * written either: a store only has content worth keeping once a record or the daemon filled it.
 *
 * `forget` drops every record of the caller's scope, and from then on nothing is read or
 * written: the daemon refused the credential they were read through.
 */
export class HostSnapshots implements ReadSnapshotStorage {
  #storage: ReadSnapshotStorage;
  #host: string | undefined;
  #waiting: ((host: string | undefined) => void)[] = [];
  #forgotten = false;

  constructor(storage: ReadSnapshotStorage, host?: string) {
    this.#storage = storage;
    this.#host = host;
  }

  /** The daemon's verified identity. The first one sticks; a different one is refused upstream. */
  identify(host: string): void {
    if (this.#host !== undefined) return;
    this.#host = host;
    this.#settle(host);
  }

  async get(key: string): Promise<unknown> {
    const host =
      this.#host ??
      (await new Promise<string | undefined>((resolve) => this.#waiting.push(resolve)));
    if (this.#forgotten || host === undefined) return undefined;
    const value = await this.#storage.get(`${host}/${key}`);
    return this.#forgotten ? undefined : value;
  }

  set(key: string, value: unknown): Promise<void> {
    if (this.#forgotten || this.#host === undefined) return Promise.resolve();
    return this.#storage.set(`${this.#host}/${key}`, value);
  }

  /** Forget every record of this scope; reads in flight come back empty. */
  forget(): Promise<void> {
    if (this.#forgotten) return Promise.resolve();
    this.#forgotten = true;
    this.#settle(undefined);
    try {
      return this.#storage.clear?.().catch(() => {}) ?? Promise.resolve();
    } catch {
      return Promise.resolve();
    }
  }

  #settle(host: string | undefined): void {
    const waiting = this.#waiting;
    this.#waiting = [];
    for (const resolve of waiting) resolve(host);
  }
}
