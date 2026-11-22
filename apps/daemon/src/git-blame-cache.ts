import type { FileBlameResult } from "@ace/git";
import { SharedWork } from "@ace/core/shared-work";

/*
 * Bounded cache for `git.blame` range reads, keyed by checkout root, the commit blamed at,
 * repository-relative path and line range: a blame at a commit never changes. Concurrent
 * requests for the same range share one Git invocation. Uses an injected clock for expiry.
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
  readonly #loading = new SharedWork<FileBlameResult>();

  constructor(now: () => number, limits: BlameCacheLimits = defaultBlameCacheLimits) {
    this.#now = now;
    this.#limits = limits;
  }

  /**
   * `key`'s blame, loaded once for everyone asking together. Each caller leaves on its own
   * signal; git is stopped only when every caller has gone.
   */
  async read(
    key: string,
    load: (signal: AbortSignal) => Promise<FileBlameResult>,
    signal?: AbortSignal,
  ): Promise<FileBlameResult> {
    const cached = this.#live(key);
    if (cached) return cached;
    return this.#loading.join(
      key,
      (stop) =>
        load(stop).then((value) => {
          // A capped answer (byte cap, work budget) is partial: kept, it would hide lines.
          if (!value.capped) this.#put(key, value);
          return value;
        }),
      signal,
    );
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
