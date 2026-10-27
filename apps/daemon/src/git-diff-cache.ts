import { createHash } from "node:crypto";
import { gitDiffFileLimit } from "@ace/protocol";

/*
 * One file's whole working-tree patch, held briefly so its pages slice one read of git instead
 * of re-running it per page. Each read is named by a validator (a hash of the patch): a page
 * asked for at a validator the file no longer has is refused, so a file edited mid-read is never
 * stitched from two diffs. Bounded in entries, code units and age (an injected clock).
 */

export interface FilePatch {
  patch: string;
  /** Git's output stopped at the read's byte cap. */
  truncated: boolean;
  validator: string;
}

export interface FilePatchLimits {
  entries: number;
  /** Code units held across entries; one file's patch never exceeds `gitDiffFileLimit`. */
  units: number;
  ttlMs: number;
}
export const filePatchLimits: FilePatchLimits = {
  entries: 4,
  units: gitDiffFileLimit,
  ttlMs: 60_000,
};

/** The refusal of a page asked for at a validator the file no longer has. */
export const diffChanged = "diff_changed";

export function patchValidator(patch: string, truncated: boolean): string {
  return createHash("sha256")
    .update(truncated ? "cut\0" : "whole\0")
    .update(patch)
    .digest("hex")
    .slice(0, 40);
}

interface Held extends FilePatch {
  at: number;
}

export class FilePatchCache {
  #now: () => number;
  #limits: FilePatchLimits;
  #held = new Map<string, Held>();
  #units = 0;
  #loading = new Map<string, Promise<FilePatch>>();

  constructor(now: () => number, limits: FilePatchLimits = filePatchLimits) {
    this.#now = now;
    this.#limits = limits;
  }

  /**
   * `key`'s patch. Without `expected`, git is read again (a first page names the version the
   * rest are read at); with it, the held read when it matches, else a new one that must match.
   */
  async read(
    key: string,
    expected: string | undefined,
    load: () => Promise<{ patch: string; truncated: boolean }>,
  ): Promise<FilePatch> {
    if (expected !== undefined) {
      const held = this.#live(key);
      if (held?.validator === expected) return held;
    }
    const fresh = expected === undefined ? this.#load(key, load) : this.#shared(key, load);
    const patch = await fresh;
    if (expected !== undefined && patch.validator !== expected) throw new Error(diffChanged);
    return patch;
  }

  /** Later pages arriving together share one read of git. */
  #shared(key: string, load: () => Promise<{ patch: string; truncated: boolean }>) {
    return this.#loading.get(key) ?? this.#load(key, load);
  }

  #load(key: string, load: () => Promise<{ patch: string; truncated: boolean }>) {
    const loading = load().then(({ patch, truncated }) => {
      const read = { patch, truncated, validator: patchValidator(patch, truncated) };
      this.#put(key, read);
      return read;
    });
    this.#loading.set(key, loading);
    const forget = () => {
      if (this.#loading.get(key) === loading) this.#loading.delete(key);
    };
    loading.then(forget, forget);
    return loading;
  }

  #live(key: string): Held | undefined {
    const held = this.#held.get(key);
    if (!held) return undefined;
    if (this.#now() - held.at > this.#limits.ttlMs) {
      this.#drop(key);
      return undefined;
    }
    return held;
  }

  #put(key: string, read: FilePatch): void {
    this.#drop(key);
    if (read.patch.length > this.#limits.units) return;
    this.#held.set(key, { ...read, at: this.#now() });
    this.#units += read.patch.length;
    const now = this.#now();
    for (const [oldest, held] of this.#held) {
      const over = this.#held.size > this.#limits.entries || this.#units > this.#limits.units;
      if (!over && now - held.at <= this.#limits.ttlMs) break;
      this.#drop(oldest);
    }
  }

  #drop(key: string): void {
    const held = this.#held.get(key);
    if (!held) return;
    this.#held.delete(key);
    this.#units -= held.patch.length;
  }
}
