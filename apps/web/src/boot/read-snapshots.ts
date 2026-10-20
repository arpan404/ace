import type { ReadSnapshotStorage } from "@ace/client";
import { idbCache } from "../lib/idb-cache.ts";

/**
 * One database for every daemon, device and account: the bounds below are the whole budget.
 * Room for a few dozen long threads across the person's machines, so a remote device opening a
 * thread it read last week paints at once (ADR 0056).
 */
export const readSnapshotBounds = {
  name: "ace.read-snapshots",
  maxEntries: 128,
  maxBytes: 64 * 1024 * 1024,
};

/** The connection records are read through. The token is part of it but never stored. */
export interface SnapshotTarget {
  url: string;
  token: string;
  deviceId: string;
  pairedDeviceId?: string | undefined;
  localHostId?: string | undefined;
  hostId?: string | undefined;
}

/** A SHA-256 of the connection: every key of its records starts with it. */
async function scopeOf(target: SnapshotTarget): Promise<string> {
  const identity = JSON.stringify([
    target.url,
    target.localHostId ?? target.hostId ?? null,
    target.deviceId,
    target.pairedDeviceId ?? null,
    target.token,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cache() {
  // Boundary code: the cache's use stamps read the wall clock.
  return idbCache({
    ...readSnapshotBounds,
    decode(value: unknown) {
      if (typeof value !== "string") throw new Error("Not a read snapshot");
      return value;
    },
    weigh: (value: string) => value.length * 2 + 512,
    now: () => Date.now(),
  });
}

/**
 * The client's read snapshots in IndexedDB (ADR 0030, bounds in ADR 0056). Records are kept
 * under a SHA-256 of the connection they were read through (daemon address and identity,
 * device, paired account and token), so another daemon, device or credential never reads them,
 * and the token itself is never stored. Values are stored as JSON text, serialized when `set`
 * is called. A failure of any kind is a miss. `clear` drops this connection's records.
 */
export function browserReadSnapshots(target: SnapshotTarget): ReadSnapshotStorage {
  const scope = scopeOf(target);
  const records = cache();
  return {
    async get(key) {
      try {
        const text = await records.get(`${await scope}:${key}`);
        return text === undefined ? undefined : JSON.parse(text);
      } catch {
        return undefined;
      }
    },
    async set(key, value) {
      // Serialized before the first await: the store keeps streaming meanwhile.
      let text: string;
      try {
        text = JSON.stringify(value);
      } catch {
        return;
      }
      try {
        await records.set(`${await scope}:${key}`, text);
      } catch {
        // An optional cache: a write that fails is a miss next time.
      }
    },
    async clear() {
      await records.forget(`${await scope}:`);
    },
  };
}

/** Delete what was read through `target`: its credential is being dropped. */
export function forgetReadSnapshots(target: SnapshotTarget): Promise<void> {
  return browserReadSnapshots(target).clear?.() ?? Promise.resolve();
}

/** Delete every connection's records: this window is forgetting all of its credentials. */
export function forgetAllReadSnapshots(): Promise<void> {
  return cache().clear();
}
