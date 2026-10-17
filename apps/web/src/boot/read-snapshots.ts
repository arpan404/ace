import type { ReadSnapshotStorage } from "@ace/client";
import { idbCache } from "../lib/idb-cache.ts";

/** One global budget across endpoints/accounts/devices, with opaque SHA-256 identity keys. */
export function browserReadSnapshots(target: {
  url: string;
  token: string;
  deviceId: string;
  pairedDeviceId?: string | undefined;
  localHostId?: string | undefined;
  hostId?: string | undefined;
}): ReadSnapshotStorage {
  const scope = Promise.resolve().then(async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify([
        target.url,
        target.localHostId ?? target.hostId ?? null,
        target.deviceId,
        target.pairedDeviceId ?? null,
        target.token,
      ]),
    );
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  });
  const cache = idbCache({
    name: "ace.read-snapshots.v1",
    maxEntries: 32,
    maxBytes: 16 * 1024 * 1024,
    decode(value: unknown) {
      if (typeof value !== "string") throw new Error("Invalid snapshot");
      return value;
    },
    weigh: (value: string) => value.length * 2 + 512,
    now: () => Date.now(),
  });
  return {
    async get(key) {
      try {
        const value = await cache.get(`${await scope}:${key}`);
        return value === undefined ? undefined : JSON.parse(value);
      } catch {
        return undefined;
      }
    },
    async set(key, value) {
      // Capture synchronously before scope hashing/IndexedDB yields to streaming events.
      const serialized = JSON.stringify(value);
      try {
        await cache.set(`${await scope}:${key}`, serialized);
      } catch {
        /* optional cache */
      }
    },
  };
}
