import { FilesRequestError } from "@ace/files-native";

/** What the root book needs from ace-files; a test injects counts in place of a process. */
export type RootPorts = {
  /** The canonical folder an open root means, so two spellings share one root. */
  canonicalize(path: string): Promise<string>;
  open(path: string): Promise<number>;
  close(root: number): Promise<void>;
  now(): number;
};

/** One open root a caller holds: its number stays valid until `release`. */
export type RootHold = { readonly root: number; readonly path: string; release(): void };

type Root = { path: string; opening: Promise<number>; lastUsed: number; holds: number };

/** A root nobody holds closes this long after its last use. */
export const rootIdleMs = 10 * 60_000;

/**
 * The checkouts ace-files has open, one per canonical folder, shared by every thread that runs
 * there. A root whose last use is older than the idle window closes, so a daemon that browsed
 * twenty worktrees does not keep twenty watchers and path indexes alive; a root with a live watch
 * or a request in flight is held and never closes underneath it.
 */
export class FilesRoots {
  readonly #ports: RootPorts;
  readonly #idleMs: number;
  readonly #roots = new Map<string, Root>();
  #closed = false;

  constructor(ports: RootPorts, idleMs = rootIdleMs) {
    this.#ports = ports;
    this.#idleMs = idleMs;
  }

  /** Run `task` against the root for `path`, opening it first when nobody has. */
  async use<T>(path: string, task: (root: number) => Promise<T>): Promise<T> {
    const canonical = await this.#ports.canonicalize(path);
    const root = this.#root(canonical);
    root.holds++;
    try {
      return await task(await root.opening);
    } finally {
      root.holds--;
      root.lastUsed = this.#ports.now();
    }
  }

  /** Keep the root open until `release`: a watch outlives any one request. */
  async hold(path: string): Promise<RootHold> {
    const canonical = await this.#ports.canonicalize(path);
    const root = this.#root(canonical);
    root.holds++;
    let number: number;
    try {
      number = await root.opening;
    } catch (error) {
      root.holds--;
      throw error;
    }
    let released = false;
    return {
      root: number,
      path: canonical,
      release: () => {
        if (released) return;
        released = true;
        root.holds--;
        root.lastUsed = this.#ports.now();
      },
    };
  }

  /** Close every root nobody holds that has been idle for the window; returns their paths. */
  async sweep(): Promise<string[]> {
    const now = this.#ports.now();
    const closed: string[] = [];
    for (const [canonical, root] of this.#roots) {
      if (root.holds > 0 || now - root.lastUsed < this.#idleMs) continue;
      if (this.#roots.get(canonical) !== root) continue;
      this.#roots.delete(canonical);
      closed.push(canonical);
      await this.#closeQuietly(root);
    }
    return closed;
  }

  /** Close every root now; the process is going away. */
  async close(): Promise<void> {
    this.#closed = true;
    const roots = [...this.#roots.values()];
    this.#roots.clear();
    await Promise.all(roots.map((root) => this.#closeQuietly(root)));
  }

  #root(canonical: string): Root {
    const existing = this.#roots.get(canonical);
    if (existing) return existing;
    if (this.#closed) throw new FilesRequestError("CANCELLED", "ace-files roots are closed");
    const root: Root = {
      path: canonical,
      opening: this.#ports.open(canonical),
      lastUsed: this.#ports.now(),
      holds: 0,
    };
    this.#roots.set(canonical, root);
    // A root ace-files refused (the folder vanished) is looked up again next time.
    root.opening.catch(() => {
      if (this.#roots.get(canonical) === root) this.#roots.delete(canonical);
    });
    return root;
  }

  async #closeQuietly(root: Root): Promise<void> {
    try {
      await this.#ports.close(await root.opening);
    } catch {
      // The process is gone or the folder vanished; the root is closed either way.
    }
  }
}
