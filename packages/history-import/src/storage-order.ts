import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { object, timestamp, readHeadTail, walkFiles } from "@ace/native-session";
import type { ProviderHome } from "./contracts.ts";

type Entry = { at: number; id: string; path: string; value: unknown; bytes: number };
/** Directory enumeration order is not transcript order. Sort on disk, not in a history-sized array. */
async function* ordered(
  entries: AsyncIterable<Entry>,
  scratchRoot: string,
  signal: AbortSignal,
): AsyncGenerator<{ path: string; value: unknown; bytes: number }> {
  const stage = await mkdtemp(join(scratchRoot, "storage-order-"));
  const db = new DatabaseSync(join(stage, "order.sqlite"));
  try {
    db.exec(
      "PRAGMA cache_size=-2048;CREATE TABLE entries(at INTEGER NOT NULL,id TEXT NOT NULL,path TEXT PRIMARY KEY,value TEXT NOT NULL,bytes INTEGER NOT NULL);BEGIN",
    );
    const insert = db.prepare("INSERT INTO entries VALUES(?,?,?,?,?)");
    let count = 0;
    for await (const entry of entries) {
      signal.throwIfAborted();
      if (++count > 100000) throw new Error("Legacy storage inventory limit exceeded");
      insert.run(entry.at, entry.id, entry.path, JSON.stringify(entry.value), entry.bytes);
    }
    db.exec("COMMIT;CREATE INDEX entry_order ON entries(at,id)");
    for (const row of db.prepare("SELECT path,value,bytes FROM entries ORDER BY at,id").iterate()) {
      signal.throwIfAborted();
      yield {
        path: String(row.path),
        value: JSON.parse(String(row.value)),
        bytes: Number(row.bytes),
      };
    }
  } finally {
    db.close();
    await rm(stage, { recursive: true, force: true });
  }
}
export function orderedMessages(
  instance: ProviderHome,
  root: string,
  scratchRoot: string,
  signal: AbortSignal,
) {
  const entries = async function* (): AsyncGenerator<Entry> {
    for await (const path of walkFiles(root, signal)) {
      const sample = await readHeadTail(instance.homeDir, path, signal);
      if (!sample.exact || sample.records.length !== 1)
        throw new Error(
          "A saved OpenCode message is too large or unreadable. Open this conversation in OpenCode to recover its history.",
        );
      const r = object(sample.records[0]);
      yield {
        at: timestamp(object(r.time).created) ?? 0,
        id: basename(path),
        path,
        value: sample.records[0],
        bytes: sample.bytes,
      };
    }
  };
  return ordered(entries(), scratchRoot, signal);
}
export async function* orderedParts(
  root: string,
  scratchRoot: string,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const iterator = walkFiles(root, signal);
  const first: string[] = [];
  try {
    while (first.length < 16) {
      const next = await iterator.next();
      if (next.done) {
        yield* first.toSorted();
        return;
      }
      first.push(next.value);
    }
    const extra = await iterator.next();
    if (extra.done) {
      yield* first.toSorted();
      return;
    }
    const entries = async function* (): AsyncGenerator<Entry> {
      for (const path of first) yield { at: 0, id: basename(path), path, value: null, bytes: 0 };
      yield { at: 0, id: basename(extra.value), path: extra.value, value: null, bytes: 0 };
      for await (const path of iterator)
        yield { at: 0, id: basename(path), path, value: null, bytes: 0 };
    };
    for await (const row of ordered(entries(), scratchRoot, signal)) yield row.path;
  } finally {
    await iterator.return(undefined);
  }
}
