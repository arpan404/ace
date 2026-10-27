import { requester } from "@ace/native-host";
import { createNodeHost } from "@ace/native-host/node";
import { z } from "zod";

/**
 * The native snapshot store's contract (`SnapshotStore.swift`), in memory, through the host:
 * whole records, and threads as a head plus one row per item.
 */
export function nativeStore() {
  const records = new Map<string, string>();
  const threads = new Map<string, { head: string; settled: boolean }>();
  const items = new Map<string, Map<string, string>>();
  const Write = z.object({
    key: z.string(),
    settled: z.boolean(),
    ids: z.array(z.string()),
    removed: z.array(z.string()),
    replace: z.boolean(),
  });
  const call = requester(
    createNodeHost({
      operations: {
        "snapshot.get": (key) => records.get(String(key)) ?? "",
        "snapshot.set": (input, body) => {
          const { key } = z.object({ key: z.string() }).parse(input);
          records.set(key, body ?? "");
          return "";
        },
        "snapshot.thread.get": (key) => {
          const thread = threads.get(String(key));
          if (!thread) return "";
          return [thread.head, ...(items.get(String(key))?.values() ?? [])].join("\n");
        },
        "snapshot.thread.put": (input, body) => {
          const write = Write.parse(input);
          const [head = "", ...lines] = (body ?? "").split("\n");
          const held = write.replace
            ? new Map<string, string>()
            : (items.get(write.key) ?? new Map());
          for (const id of write.removed) held.delete(id);
          write.ids.forEach((id, index) => held.set(id, lines[index] ?? ""));
          items.set(write.key, held);
          threads.set(write.key, { head, settled: write.settled });
          return "";
        },
        "snapshot.index": () =>
          JSON.stringify([
            ...[...records].map(([key, text]) => ({
              key,
              kind: "record",
              used: 0,
              bytes: text.length,
              settled: false,
            })),
            ...[...threads].map(([key, thread]) => ({
              key,
              kind: "thread",
              used: 0,
              bytes: thread.head.length,
              settled: thread.settled,
            })),
          ]),
        "snapshot.drop": (input) => {
          for (const key of z.object({ keys: z.array(z.string()) }).parse(input).keys) {
            records.delete(key);
            threads.delete(key);
            items.delete(key);
          }
          return "";
        },
        "snapshot.size": () => {
          let bytes = 0;
          for (const text of records.values()) bytes += text.length;
          for (const thread of threads.values()) bytes += thread.head.length;
          for (const held of items.values()) for (const text of held.values()) bytes += text.length;
          return String(bytes);
        },
        "snapshot.clear": () => {
          records.clear();
          threads.clear();
          items.clear();
          return "";
        },
      },
    }),
  );
  return { call, items };
}
