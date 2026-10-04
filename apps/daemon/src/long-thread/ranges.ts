import { z } from "zod";
import { TurnDigest, type Event } from "@ace/protocol";
import { LongThreadDatabase, type Counters } from "./database.ts";
import { rangeBuckets, rangePrefix, rangeSuffix } from "./range-shape.ts";

const Aggregate = z.object({ owner: z.string(), key: z.string(), value: z.number() });
const Completion = z.object({ seq: z.number(), at: z.number() });
const fileOwner = (path: string) => `file:${path}`;

/** Persisted range sums. Writes touch seven nodes; reads never traverse transcript history. */
export class Ranges {
  constructor(privateData: LongThreadDatabase) {
    this.data = privateData;
  }
  private readonly data: LongThreadDatabase;
  add(thread: string, owner: string, key: string, position: number, delta: number): void {
    if (!delta) return;
    const update = this.data.sql(
      "INSERT INTO long_range_nodes VALUES(?,?,?,?,?,?) ON CONFLICT(thread_id,owner,level,bucket,key) DO UPDATE SET value=value+excluded.value",
    );
    for (const { level, bucket } of rangeBuckets(position))
      update.run(thread, owner, level, bucket, key, delta);
  }
  after(thread: string, owners: readonly string[], cutoff: number): Map<string, Counters> {
    const bounds = rangePrefix(cutoff);
    const rows = this.data
      .sql(`WITH bounds(level,low,high) AS (VALUES ${bounds.map(() => "(?,?,?)").join(",")}),
      sums AS (
        SELECT owner,key,SUM(value) AS value FROM long_range_nodes
        WHERE thread_id=? AND owner IN (SELECT value FROM json_each(?)) AND level=6 GROUP BY owner,key
        UNION ALL
        SELECT n.owner,n.key,-SUM(n.value) AS value FROM bounds b CROSS JOIN long_range_nodes n
        WHERE n.thread_id=? AND n.owner IN (SELECT value FROM json_each(?)) AND n.level=b.level AND n.bucket>=b.low AND n.bucket<b.high GROUP BY n.owner,n.key
      ) SELECT owner,key,SUM(value) AS value FROM sums GROUP BY owner,key`)
      .all(
        ...bounds.flatMap(({ level, low, high }) => [level, low, high]),
        thread,
        JSON.stringify(owners),
        thread,
        JSON.stringify(owners),
      );
    const result = new Map<string, Counters>();
    for (const value of rows) {
      const row = Aggregate.parse(value);
      let counters = result.get(row.owner);
      if (!counters) {
        counters = {};
        result.set(row.owner, counters);
      }
      counters[row.key] = row.value;
    }
    return result;
  }
  counter(event: Event, key: string, delta: number): void {
    this.add(event.threadId, "counters", key, event.at, delta);
  }
  file(
    event: Pick<Event, "threadId" | "seq" | "at">,
    path: string,
    added: number,
    removed: number,
    unknown: number,
    refs: number,
  ): void {
    const owner = fileOwner(path);
    this.add(event.threadId, owner, "added", event.at, added);
    this.add(event.threadId, owner, "removed", event.at, removed);
    this.add(event.threadId, owner, "unknown", event.at, unknown);
    this.fileReferences(event, path, refs);
    this.data.run(
      "INSERT INTO long_time_files VALUES(?,?,?,?) ON CONFLICT(thread_id,path) DO UPDATE SET at=MAX(at,excluded.at),seq=MAX(seq,excluded.seq)",
      event.threadId,
      path,
      event.at,
      event.seq,
    );
  }
  fileReferences(event: Pick<Event, "threadId" | "at">, path: string, delta: number): void {
    this.add(event.threadId, fileOwner(path), "refs", event.at, delta);
  }
  fileCounters(thread: string, paths: readonly string[], cutoff: number): Map<string, Counters> {
    const values = this.after(thread, paths.map(fileOwner), cutoff);
    return new Map(paths.map((path) => [path, values.get(fileOwner(path)) ?? {}]));
  }
  command(
    event: Pick<Event, "threadId" | "seq" | "at">,
    item: string,
    command: TurnDigest["commands"][number] | undefined,
  ): void {
    const body = command ? JSON.stringify(command) : null;
    this.data.run(
      `INSERT INTO long_time_commands VALUES(?,?,?,?,?) ON CONFLICT(thread_id,item_id) DO UPDATE SET at=MAX(at,excluded.at),seq=MAX(seq,excluded.seq),data=excluded.data`,
      event.threadId,
      item,
      event.at,
      event.seq,
      body,
    );
    for (const { level, bucket } of rangeBuckets(event.at))
      this.data.run(
        "INSERT INTO long_time_command_nodes VALUES(?,?,?,?,?,?) ON CONFLICT(thread_id,item_id,level,bucket) DO UPDATE SET seq=excluded.seq,data=excluded.data WHERE excluded.seq>seq",
        event.threadId,
        item,
        level,
        bucket,
        event.seq,
        body,
      );
  }
  commandsAfter(
    thread: string,
    time: number,
  ): { commands: TurnDigest["commands"]; truncated: boolean } {
    const items = this.data
      .sql(
        "SELECT item_id FROM long_time_commands WHERE thread_id=? AND at>? ORDER BY at,item_id LIMIT 65",
      )
      .all(thread, time)
      .map((row) => z.object({ item_id: z.string() }).parse(row).item_id);
    const bounds = rangeSuffix(time);
    // SQLite's single MAX aggregate selects the data belonging to that maximum seq.
    // Tied nodes contain the same canonical event body, so tie selection is immaterial.
    const rows = this.data
      .sql(`WITH bounds(level,low,high) AS (VALUES ${bounds.map(() => "(?,?,?)").join(",")})
      SELECT n.item_id,n.data,MAX(n.seq) AS seq FROM bounds b CROSS JOIN long_time_command_nodes n
      WHERE n.thread_id=? AND n.item_id IN (SELECT value FROM json_each(?)) AND n.level=b.level AND n.bucket>=b.low AND n.bucket<b.high GROUP BY n.item_id ORDER BY n.item_id`)
      .all(
        ...bounds.flatMap(({ level, low, high }) => [level, low, high]),
        thread,
        JSON.stringify(items.slice(0, 64)),
      );
    const commands = rows.flatMap((row) =>
      row.data === null
        ? []
        : [TurnDigest.shape.commands.element.parse(JSON.parse(String(row.data)))],
    );
    return { commands, truncated: items.length > 64 };
  }
  completion(thread: string, ordinal: number, next: { seq: number; at: number } | undefined): void {
    const raw = this.data
      .sql("SELECT seq,at FROM long_completions WHERE thread_id=? AND ordinal=?")
      .get(thread, ordinal);
    const old = raw ? Completion.parse(raw) : undefined;
    if (old?.seq === next?.seq && old?.at === next?.at) return;
    if (old) {
      this.add(thread, "completed:seq", "completed", old.seq, -1);
      this.add(thread, "completed:time", "completed", old.at, -1);
    }
    if (next) {
      this.add(thread, "completed:seq", "completed", next.seq, 1);
      this.add(thread, "completed:time", "completed", next.at, 1);
      this.data.run(
        "INSERT INTO long_completions VALUES(?,?,?,?) ON CONFLICT(thread_id,ordinal) DO UPDATE SET seq=excluded.seq,at=excluded.at",
        thread,
        ordinal,
        next.seq,
        next.at,
      );
    } else
      this.data.run(
        "DELETE FROM long_completions WHERE thread_id=? AND ordinal=?",
        thread,
        ordinal,
      );
  }
  completedAfter(thread: string, cutoff: { sinceSeq: number } | { sinceTime: number }): number {
    const owner = "sinceSeq" in cutoff ? "completed:seq" : "completed:time";
    const position = "sinceSeq" in cutoff ? cutoff.sinceSeq : cutoff.sinceTime;
    return Math.max(0, this.after(thread, [owner], position).get(owner)?.completed ?? 0);
  }
}
