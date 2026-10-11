import { repositoryKey } from "@ace/forge";
import type { ForgePrRef } from "@ace/protocol";
export const forgeResourceKey = (ref: ForgePrRef): string =>
  JSON.stringify([repositoryKey(ref.repository), ref.number]);
/** Instance-owned mutation exclusion and publication revisions, shared by action owners. */
export class ForgeResourceOwner {
  readonly #active = new Set<string>();
  readonly #revisions = new Map<string, object>();
  capture(ref: ForgePrRef): object {
    const key = forgeResourceKey(ref);
    let revision = this.#revisions.get(key);
    if (!revision) {
      revision = {};
      this.#revisions.set(key, revision);
      if (this.#revisions.size > 4096) {
        const oldest = this.#revisions.keys().next().value;
        if (oldest !== undefined) this.#revisions.delete(oldest);
      }
    }
    return revision;
  }
  current(ref: ForgePrRef, revision: object): boolean {
    return (
      this.#revisions.get(forgeResourceKey(ref)) === revision &&
      !this.#active.has(forgeResourceKey(ref))
    );
  }
  acquire(ref: ForgePrRef): () => void {
    const key = forgeResourceKey(ref);
    if (this.#active.has(key) || this.#active.size >= 16) throw new Error("forge_write_pending");
    this.#active.add(key);
    this.#revisions.set(key, {});
    return () => {
      this.#active.delete(key);
      this.#revisions.set(key, {});
    };
  }
}
