/** Where a repository's default branch can come from, most authoritative first. */
export interface DefaultBranchSources {
  /** The selected remote's `HEAD`: recorded locally, else one bounded `ls-remote`. */
  remote(): Promise<string | undefined>;
  /** The forge repository's `default_branch`. */
  forge(): Promise<string | undefined>;
  /** Local guess (`main`, `master`, `init.defaultBranch`), never cached. */
  local(): Promise<string>;
}

/**
 * Resolves a checkout's default branch and caches the remote or forge answer, including "no
 * answer", so an offline remote costs one bounded query per window rather than one per read.
 */
export class DefaultBranches {
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #cache = new Map<string, { branch: string | undefined; at: number }>();
  constructor(now: () => number, ttlMs = 600_000) {
    this.#now = now;
    this.#ttlMs = ttlMs;
  }
  async resolve(key: string, sources: DefaultBranchSources): Promise<string> {
    const now = this.#now();
    const cached = this.#cache.get(key);
    let branch: string | undefined;
    if (cached && now - cached.at >= 0 && now - cached.at < this.#ttlMs) branch = cached.branch;
    else {
      branch = (await sources.remote()) ?? (await sources.forge());
      this.#cache.delete(key);
      this.#cache.set(key, { branch, at: now });
      while (this.#cache.size > 256) {
        const oldest = this.#cache.keys().next().value;
        if (oldest === undefined) break;
        this.#cache.delete(oldest);
      }
    }
    return branch ?? (await sources.local());
  }
}
