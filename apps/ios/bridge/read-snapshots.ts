import type { ReadSnapshotStorage } from "@ace/client";

/** A host call: an operation name and its JSON input, answered with text. */
export type HostCall = (operation: string, input?: unknown) => Promise<string>;

/**
 * The SDK's read snapshots (ADR 0030) in the phone's own storage, as the web keeps them in
 * IndexedDB: what the SDK held for the inbox and opened threads paints from disk on the next
 * launch, unconfirmed, while the socket connects. The native store sits beside this machine's
 * outbox, so it is already scoped to one daemon and device; the SDK files records under the
 * daemon's verified identity on top. Values travel as JSON text, serialized before the first
 * await because the stores they come from keep changing. A failure of any kind is a miss.
 */
export function nativeReadSnapshots(call: HostCall): ReadSnapshotStorage {
  return {
    async get(key) {
      try {
        const text = await call("snapshot.get", key);
        return text === "" ? undefined : JSON.parse(text);
      } catch {
        return undefined;
      }
    },
    async set(key, value) {
      let text: string;
      try {
        text = JSON.stringify(value);
      } catch {
        return;
      }
      try {
        await call("snapshot.set", { key, value: text });
      } catch {
        // An optional cache: a write that fails is a miss next time.
      }
    },
    async clear() {
      await call("snapshot.clear").catch(() => "");
    },
  };
}
