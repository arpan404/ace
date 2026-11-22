import type { FileBlameResult } from "@ace/git";

/*
 * Bounded cache for `git.blame` range reads, keyed by checkout root, HEAD, file stat stamp,
 * repository-relative path, and line range. Concurrent requests for the same range share one
 * Git invocation. Uses an injected clock for deterministic expiry.
 */

export interface BlameCacheLimits {
  entries: number;
  ttlMs: number;
}

export const defaultBlameCacheLimits: BlameCacheLimits = {
  entries: 64,
  ttlMs: 5 * 60_000,
};

interface HeldBlame {
  value: FileBlameResult;
  at: number;
}

export class GitBlameCache {
  readonly #now: () => number;
  readonly #limits: BlameCacheLimits;
  readonly #held = new Map<string, HeldBlame>();
  readonly #loading = new Map<string, Promise<FileBlameResult>>();

  constructor(now: () => number, limits: BlameCacheLimits = defaultBlameCacheLimits) {
    this.#now = now;
    this.#limits = limits;
  }

  read(key: string, load: () => Promise<FileBlameResult>): Promise<FileBlameResult> {
    const cached = this.#live(key);
    if (cached) return Promise.resolve(cached);
    const active = this.#loading.get(key);
    if (active) return active;
    const pending = load().then((value) => {
      this.#put(key, value);
      return value;
    });
    this.#loading.set(key, pending);
    const forget = () => {
      if (this.#loading.get(key) === pending) this.#loading.delete(key);
    };
    pending.then(forget, forget);
    return pending;
  }

  #live(key: string): FileBlameResult | undefined {
    const entry = this.#held.get(key);
    if (!entry) return undefined;
    if (this.#now() - entry.at > this.#limits.ttlMs) {
      this.#held.delete(key);
      return undefined;
    }
    // Refresh LRU order on hit.
    this.#held.delete(key);
    this.#held.set(key, entry);
    return entry.value;
  }

  #put(key: string, value: FileBlameResult): void {
    this.#held.delete(key);
    const now = this.#now();
    this.#held.set(key, { value, at: now });
    for (const [oldest, entry] of this.#held) {
      if (this.#held.size <= this.#limits.entries && now - entry.at <= this.#limits.ttlMs) break;
      this.#held.delete(oldest);
    }
  }
}
