import { z } from "zod";
import { ThreadId, SearchKind, type Event } from "@ace/protocol";
import { acceptsDelta } from "@ace/projection";
import { StoredText, storeText } from "./encoding.ts";
import { FIELD_CAP, truncateText } from "./text.ts";
import type { Statements } from "./writer.ts";
import type { OutputReader } from "./output.ts";
import { threadItemText } from "./thread-text.ts";

const Segment = z.object({
  id: z.number(),
  thread: z.string(),
  item: z.string(),
  category: z.string(),
  stream: z.string().nullable(),
  encoding: z.string().nullable(),
  target: z.number(),
  offset: z.number(),
  tail: StoredText,
  chunk_id: z.number().nullable(),
});
const Owner = z.object({
  kind: SearchKind.exclude(["thread"]),
  tool_kind: z.string().nullable(),
  delta_segment: z.number().nullable(),
});
const Key = z.object({ id: z.number() });
const Seq = z.object({ seq: z.number() });
const Bytes = z.instanceof(Uint8Array).refine((value) => value.length <= 32768);

export class ThreadSearchWriter {
  private readonly sql: Statements;
  private readonly readOutput: OutputReader | undefined;
  private sourceCursor = 0;
  constructor(sql: Statements, readOutput?: OutputReader) {
    this.sql = sql;
    this.readOutput = readOutput;
  }
  seq(): number {
    return Seq.parse(this.sql.get("SELECT seq FROM search_full_meta WHERE id=1").get()).seq;
  }
  advance(seq: number): void {
    this.sql.run("UPDATE search_full_meta SET seq=? WHERE id=1", seq);
  }
  stage(event: Event): void {
    if (this.sql.get("SELECT 1 FROM search_tombstones WHERE thread=?").get(event.threadId)) return;
    const payload = event.payload;
    if (payload.type === "item.deleted") {
      this.deleteItem(event.threadId, payload.itemId);
      return;
    }
    if (payload.type === "item.delta") {
      const value = this.sql
        .get("SELECT * FROM search_full_items WHERE thread=? AND item=?")
        .get(event.threadId, payload.itemId);
      if (!value) return;
      const owner = Owner.parse(value);
      if (!acceptsDelta(owner.kind, payload.field, owner.tool_kind ?? undefined)) return;
      let id = owner.delta_segment;
      if (id === null) {
        id = this.segment(
          event.threadId,
          payload.itemId,
          "delta",
          owner.kind === "message" ? "messages" : "tool_output",
          event.seq,
        );
        this.sql.run(
          "UPDATE search_full_items SET delta_segment=? WHERE thread=? AND item=?",
          id,
          event.threadId,
          payload.itemId,
        );
      }
      const segment = this.get(id);
      if (segment.stream && this.readOutput) {
        this.sql.run(
          "UPDATE search_full_segments SET target=target+? WHERE id=?",
          segment.encoding === "utf-16le"
            ? payload.append.length * 2
            : Buffer.byteLength(payload.append),
          id,
        );
      } else this.append(id, payload.append);
      return;
    }
    if (payload.type !== "item.created" && payload.type !== "item.updated") return;
    const item = payload.item;
    this.sql.run(
      `INSERT INTO search_full_items(thread,item,seq,kind,tool_kind) VALUES(?,?,?,?,?)
      ON CONFLICT(thread,item) DO UPDATE SET kind=excluded.kind,tool_kind=excluded.tool_kind,delta_segment=NULL`,
      event.threadId,
      item.id,
      event.seq,
      item.type,
      item.type === "tool_call" ? item.call.detail.kind : null,
    );
    let delta: number | null = null;
    for (const part of threadItemText(item)) {
      const id = this.segment(event.threadId, item.id, part.name, part.category, event.seq);
      const previous = this.get(id);
      this.sql.run("UPDATE search_full_segments SET category=? WHERE id=?", part.category, id);
      const source = this.readOutput ? part.source : undefined;
      const reusable =
        source &&
        source.streamId === previous.stream &&
        source.encoding === previous.encoding &&
        source.bytes >= previous.target &&
        previous.category === part.category;
      if (!reusable) {
        this.sql.run("DELETE FROM search_full_chunks WHERE segment=?", id);
        this.sql.run(
          "UPDATE search_full_segments SET tail='t',chunk_id=NULL,offset=0,target=0,dirty=0,stream=NULL,encoding=NULL WHERE id=?",
          id,
        );
      }
      if (source)
        this.sql.run(
          "UPDATE search_full_segments SET stream=?,encoding=?,target=? WHERE id=?",
          source.streamId,
          source.encoding,
          source.bytes,
          id,
        );
      else {
        this.append(id, part.text);
      }
      if (
        (item.type === "message" && part.category === "messages") ||
        part.name === "text" ||
        part.name === "output"
      )
        delta = id;
    }
    // A message ending in an attachment receives a fresh text segment on its next delta.
    if (item.type === "message" && item.parts.at(-1)?.type !== "text") delta = null;
    this.sql.run(
      "UPDATE search_full_items SET delta_segment=? WHERE thread=? AND item=?",
      delta,
      event.threadId,
      item.id,
    );
    for (;;) {
      const stale = this.sql
        .get(
          "SELECT id FROM search_full_segments WHERE thread=? AND item=? AND revision<>? LIMIT 128",
        )
        .all(event.threadId, item.id, event.seq);
      if (!stale.length) break;
      for (const row of stale) this.removeSegment(Key.parse(row).id);
    }
  }
  private segment(
    thread: string,
    item: string,
    name: string,
    category: string,
    revision: number,
  ): number {
    this.sql.run(
      `INSERT INTO search_full_segments(thread,item,name,category,revision) VALUES(?,?,?,?,?)
      ON CONFLICT(thread,item,name) DO UPDATE SET revision=excluded.revision`,
      thread,
      item,
      name,
      category,
      revision,
    );
    return Key.parse(
      this.sql
        .get("SELECT id FROM search_full_segments WHERE thread=? AND item=? AND name=?")
        .get(thread, item, name),
    ).id;
  }
  private get(id: number): z.infer<typeof Segment> {
    return Segment.parse(this.sql.get("SELECT * FROM search_full_segments WHERE id=?").get(id));
  }
  private append(id: number, text: string): void {
    let row = this.get(id);
    // Persist only a bounded tail. Each sealed chunk is indexed once.
    for (let offset = 0; offset < text.length;) {
      const take = Math.min(FIELD_CAP - row.tail.length, text.length - offset);
      const tail = row.tail + text.slice(offset, offset + take);
      offset += take;
      this.sql.run(
        "UPDATE search_full_segments SET tail=?,dirty=1 WHERE id=?",
        storeText(tail),
        id,
      );
      if (tail.length === FIELD_CAP) {
        this.publish(id);
        const cut = truncateText(tail, FIELD_CAP - 512).length;
        // Overlap preserves words and phrases crossing a storage boundary.
        this.sql.run(
          "UPDATE search_full_segments SET tail=?,chunk_id=NULL,dirty=1 WHERE id=?",
          storeText(tail.slice(cut)),
          id,
        );
      }
      row = this.get(id);
    }
  }
  private publish(id: number): void {
    const row = this.get(id);
    const body = row.tail.toWellFormed().replaceAll("\u0001", " ").replaceAll("\u0002", " ");
    if (row.chunk_id !== null)
      this.sql.run("UPDATE search_full_chunks SET body=? WHERE id=?", body, row.chunk_id);
    else if (body) {
      const seq = Seq.parse(
        this.sql
          .get("SELECT seq FROM search_full_items WHERE thread=? AND item=?")
          .get(row.thread, row.item),
      ).seq;
      const inserted = this.sql
        .get(
          "INSERT INTO search_full_chunks(segment,thread,item,seq,category,body) VALUES(?,?,?,?,?,?) RETURNING id",
        )
        .get(id, row.thread, row.item, seq, row.category, body);
      this.sql.run(
        "UPDATE search_full_segments SET chunk_id=? WHERE id=?",
        Key.parse(inserted).id,
        id,
      );
    }
    this.sql.run("UPDATE search_full_segments SET dirty=0 WHERE id=?", id);
  }
  /** Every iteration reads at most 32 KiB and persists its restart cursor. */
  flush(limit: number): number {
    let count = 0;
    if (this.readOutput)
      for (; count < limit; count++) {
        const value =
          this.sql
            .get(
              "SELECT * FROM search_full_segments WHERE offset<target AND id>? ORDER BY id LIMIT 1",
            )
            .get(this.sourceCursor) ??
          this.sql
            .get("SELECT * FROM search_full_segments WHERE offset<target ORDER BY id LIMIT 1")
            .get();
        if (!value) break;
        const row = Segment.parse(value);
        this.sourceCursor = row.id;
        if (!row.stream) throw new Error("Invalid search source");
        const input = this.readOutput(
          ThreadId.parse(row.thread),
          row.stream,
          row.offset,
          Math.min(32768, row.target - row.offset),
        );
        if (!input?.length) break;
        const bytes = Bytes.parse(input);
        let used = bytes.length;
        if (row.offset + used < row.target) {
          if (row.encoding === "utf-16le") {
            used -= used % 2;
            if (used >= 2) {
              const unit = (bytes[used - 2] ?? 0) + ((bytes[used - 1] ?? 0) << 8);
              if (unit >= 0xd800 && unit <= 0xdbff) used -= 2;
            }
          } else {
            let start = used - 1;
            while (start >= 0 && ((bytes[start] ?? 0) & 0xc0) === 0x80) start--;
            const first = bytes[start] ?? 0;
            const width = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
            if (start + width > used) used = start;
          }
        }
        if (!used) break;
        this.append(
          row.id,
          Buffer.from(bytes.subarray(0, used)).toString(
            row.encoding === "utf-16le" ? "utf16le" : "utf8",
          ),
        );
        this.sql.run(
          "UPDATE search_full_segments SET offset=? WHERE id=?",
          row.offset + used,
          row.id,
        );
      }
    let published = 0;
    for (const value of this.sql
      .get("SELECT id FROM search_full_segments WHERE dirty=1 ORDER BY id LIMIT ?")
      .all(limit)) {
      this.publish(Key.parse(value).id);
      published++;
    }
    return count + published;
  }
  private removeSegment(id: number): void {
    this.sql.run("DELETE FROM search_full_chunks WHERE segment=?", id);
    this.sql.run("DELETE FROM search_full_segments WHERE id=?", id);
  }
  deleteItem(thread: string, item: string): void {
    this.sql.run("DELETE FROM search_full_chunks WHERE thread=? AND item=?", thread, item);
    this.sql.run("DELETE FROM search_full_segments WHERE thread=? AND item=?", thread, item);
    this.sql.run("DELETE FROM search_full_items WHERE thread=? AND item=?", thread, item);
  }
  reset(): void {
    this.sql.run("DELETE FROM search_full_chunks");
    this.sql.run("DELETE FROM search_full_segments");
    this.sql.run("DELETE FROM search_full_items");
    this.advance(0);
  }
}
