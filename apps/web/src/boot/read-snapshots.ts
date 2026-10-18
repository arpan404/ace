import type { ReadSnapshotStorage } from "@ace/client";
import { idbCache } from "../lib/idb-cache.ts";

/** One database for every daemon, device and account: the bounds below are the whole budget. */
export const readSnapshotBounds = {
  name: "ace.read-snapshots",
  maxEntries: 32,
  maxBytes: 16 * 1024 * 1024,
};

/**
 * The client's read snapshots in IndexedDB (ADR 0030, bounds in ADR 0056). Records are kept
 * under a SHA-256 of the connection they were read through (daemon address and identity,
 * device, paired account and token), so another daemon, device or credential never reads them,
 * and the token itself is never stored. Values are stored as JSON text, serialized when `set`
 * is called. A failure of any kind is a miss.
 */
export function browserReadSnapshots(target: {
  url: string;
  token: string;
  deviceId: string;
  pairedDeviceId?: string | undefined;
  localHostId?: string | undefined;
  hostId?: string | undefined;
}): ReadSnapshotStorage {
  const scope = (async () => {
    const identity = JSON.stringify([
      target.url,
      target.localHostId ?? target.hostId ?? null,
      target.deviceId,
      target.pairedDeviceId ?? null,
      target.token,
    ]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  })();
  // Boundary code: the cache's use stamps read the wall clock.
  const cache = idbCache({
    ...readSnapshotBounds,
    decode(value: unknown) {
      if (typeof value !== "string") throw new Error("Not a read snapshot");
      return value;
    },
    weigh: (value: string) => value.length * 2 + 512,
    now: () => Date.now(),
  });
  return {
    async get(key) {
      try {
        const text = await cache.get(`${await scope}:${key}`);
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
        await cache.set(`${await scope}:${key}`, text);
      } catch {
        // An optional cache: a write that fails is a miss next time.
      }
    },
  };
}
