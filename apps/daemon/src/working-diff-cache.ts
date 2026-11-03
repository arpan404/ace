/*
 * The last whole working-tree diff of each checkout, kept with the stamp it was read at. Reading
 * that diff snapshots the checkout and runs git twice; the stamp is one status read. While the
 * checkout's stamp is unchanged the held diff is served. The stamp is taken before the diff is
 * read, so a change made during the read gives the next request another stamp and a new read.
 */

export interface WorkingDiff {
  patch: string;
  truncated: boolean;
}

/** Checkouts held at once; each patch is capped by the read (256 KiB). */
const heldCheckouts = 8;

export class WorkingDiffCache {
  #held = new Map<string, { stamp: string; diff: WorkingDiff }>();
  #loading = new Map<string, Promise<WorkingDiff>>();

  /**
   * `root`'s diff: the held one when `stamp` matches it, else a new read. Requests at the same
   * stamp share one read. A checkout `stamp` can't vouch for (undefined) is always read.
   */
  async read(
    root: string,
    stamp: string | undefined,
    load: () => Promise<WorkingDiff>,
  ): Promise<WorkingDiff> {
    if (stamp === undefined) {
      this.#held.delete(root);
      return load();
    }
    const held = this.#held.get(root);
    if (held?.stamp === stamp) {
      // Most recently used last, so the oldest checkout is the one dropped.
      this.#held.delete(root);
      this.#held.set(root, held);
      return held.diff;
    }
    const key = `${root}\0${stamp}`;
    const pending = this.#loading.get(key);
    if (pending) return pending;
    const loading = load().then((diff) => {
      this.#held.delete(root);
      this.#held.set(root, { stamp, diff });
      for (const oldest of this.#held.keys()) {
        if (this.#held.size <= heldCheckouts) break;
        this.#held.delete(oldest);
      }
      return diff;
    });
    this.#loading.set(key, loading);
    const forget = () => {
      if (this.#loading.get(key) === loading) this.#loading.delete(key);
    };
    loading.then(forget, forget);
    return loading;
  }
}
