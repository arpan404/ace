import { z } from "zod";
import { ThreadId } from "@ace/protocol";
import type { Store } from "./store.ts";

const page = 256;
const Row = z.object({ thread_id: ThreadId });

/**
 * Threads an agent on a paired machine delegated here, from this machine's delegation records,
 * one page at a time in id order. Their owner is on that machine, so the notification worker is
 * told of them each time it starts: a store kept from before it recorded ownership marks them.
 */
export function* delegatedHere(store: Pick<Store, "atomic">): Generator<ThreadId[]> {
  let after = "";
  for (;;) {
    const rows = store.atomic((db) =>
      db
        .prepare(
          "SELECT thread_id FROM machine_threads WHERE kind='delegate' AND thread_id > ? ORDER BY thread_id LIMIT ?",
        )
        .all(after, page),
    );
    const threads = rows.flatMap((row) => {
      const parsed = Row.safeParse(row);
      return parsed.success ? [parsed.data.thread_id] : [];
    });
    const last = rows.at(-1);
    if (threads.length) yield threads;
    if (rows.length < page || !last) return;
    after = String(last.thread_id);
  }
}
