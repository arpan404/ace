import { z } from "zod";
import type { Event } from "@ace/protocol";
import { itemDigestContribution } from "@ace/projection";
import { LongThreadDatabase } from "./database.ts";
import { Ranges } from "./ranges.ts";

/** Durable per-item memberships reconstruct historical zero-line file references. */
export class RangeFileMigration {
  private readonly data: LongThreadDatabase;
  private readonly ranges: Ranges;
  constructor(data: LongThreadDatabase, ranges: Ranges) {
    this.data = data;
    this.ranges = ranges;
  }
  record(event: Event): void {
    const p = event.payload;
    if (p.type !== "item.created" && p.type !== "item.updated" && p.type !== "item.deleted") return;
    const id = p.type === "item.deleted" ? p.itemId : p.item.id;
    const paths =
      p.type === "item.deleted"
        ? new Set<string>()
        : new Set(itemDigestContribution(p.item).files.map((file) => file.path));
    const old = this.data
      .sql("SELECT path FROM long_range_file_members WHERE thread_id=? AND item_id=?")
      .iterate(event.threadId, id);
    for (const row of old)
      this.ranges.fileReferences(event, z.object({ path: z.string() }).parse(row).path, -1);
    this.data.run(
      "DELETE FROM long_range_file_members WHERE thread_id=? AND item_id=?",
      event.threadId,
      id,
    );
    for (const path of paths) {
      this.ranges.fileReferences(event, path, 1);
      this.data.run("INSERT INTO long_range_file_members VALUES(?,?,?)", event.threadId, id, path);
    }
  }
  cleanup(): boolean {
    return (
      this.data
        .sql(
          "DELETE FROM long_range_file_members WHERE (thread_id,item_id,path) IN (SELECT thread_id,item_id,path FROM long_range_file_members LIMIT 128) RETURNING path",
        )
        .all().length < 128
    );
  }
}
