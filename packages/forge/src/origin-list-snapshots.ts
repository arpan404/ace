import type { OriginPr } from "./origin-records.ts";

/** What one full Origin list traversal collected: every record read and whether it stopped
 * short of the end. */
export type OriginListSnapshot = { records: readonly OriginPr[]; capped: boolean };

/** How long a collected list answers page turns and filter changes before it is read again. */
export const originListSnapshotMs = 30_000;
const maxSnapshots = 4;

/**
 * Origin's list API has no totals or server-side state and text filters, so a list page is cut
 * from one traversal of every pull request. Snapshots, keyed by the traversal's request, let page
 * turns and filter changes reuse it for a short window instead of reading every page again.
 * Owners scope one instance to one admitted account.
 */
export class OriginListSnapshots {
  readonly #now: () => number;
  readonly #entries = new Map<string, { at: number; snapshot: OriginListSnapshot }>();

  constructor(now: () => number) {
    this.#now = now;
  }

  get(key: string): OriginListSnapshot | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    const age = this.#now() - entry.at;
    if (age < 0 || age >= originListSnapshotMs) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.snapshot;
  }

  set(key: string, snapshot: OriginListSnapshot): void {
    this.#entries.delete(key);
    this.#entries.set(key, { at: this.#now(), snapshot });
    while (this.#entries.size > maxSnapshots) {
      const first = this.#entries.keys().next().value;
      if (first === undefined) break;
      this.#entries.delete(first);
    }
  }
}
