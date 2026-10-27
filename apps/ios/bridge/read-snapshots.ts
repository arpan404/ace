import { RowSnapshots, type KeptSnapshot, type SnapshotRows } from "@ace/client";
import type { HostRequest } from "@ace/native-host";
import { z } from "zod";

/**
 * The SDK's read snapshots (ADR 0030) in the phone's own storage, as the web keeps them in
 * IndexedDB: what the SDK held for the inbox and opened threads paints from disk on the next
 * launch, unconfirmed, while the socket connects. Threads are kept as one row per item, each
 * finished item written once (ADR 0105); `RowSnapshots` decides what to write and what to let
 * go. The native store sits beside this machine's outbox, so it is already scoped to one daemon
 * and device; the SDK files records under the daemon's verified identity on top. A failure of
 * any kind is a miss.
 */
export function nativeReadSnapshots(call: HostRequest, now: () => number): RowSnapshots {
  return new RowSnapshots(nativeSnapshotRows(call), { now });
}

const Kept = z.array(
  z.object({
    key: z.string(),
    kind: z.enum(["thread", "record"]).catch("record"),
    used: z.number(),
    bytes: z.number(),
    settled: z.boolean().catch(false),
  }),
);

/** The rows `SnapshotStore.swift` keeps, through the host. */
export function nativeSnapshotRows(call: HostRequest): SnapshotRows {
  return {
    record: (key) => call("snapshot.get", key),
    async setRecord(key, text) {
      await call("snapshot.set", { key }, text);
    },
    async thread(key) {
      const text = await call("snapshot.thread.get", key);
      if (text === "") return undefined;
      const [head = "", ...items] = text.split("\n");
      return { head, items };
    },
    async putThread(write) {
      await call(
        "snapshot.thread.put",
        {
          key: write.key,
          settled: write.settled,
          ids: write.items.map((item) => item.id),
          removed: write.removed,
          replace: write.replace,
        },
        [write.head, ...write.items.map((item) => item.text)].join("\n"),
      );
    },
    async index(): Promise<KeptSnapshot[]> {
      return Kept.parse(JSON.parse(await call("snapshot.index")));
    },
    async drop(keys) {
      if (keys.length) await call("snapshot.drop", { keys: [...keys] });
    },
    async clear() {
      await call("snapshot.clear").catch(() => "");
    },
  };
}
