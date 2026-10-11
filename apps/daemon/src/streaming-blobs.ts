import { z } from "zod";
import { createHash } from "node:crypto";
import type { StatementSync } from "node:sqlite";
import { ThreadId } from "@ace/protocol";
const Part = z.strictObject({
  id: z.string().min(1).max(256),
  offset: z.number().int().nonnegative().max(16777216),
  text: z.string().max(65536).optional(),
  done: z.boolean().optional(),
});
const Head = z.object({
  id: z.string(),
  thread_id: ThreadId,
  size: z.number().int().nonnegative().max(16777216),
  sha256: z.string().nullable(),
  storage_id: z.string(),
  chunks: z.number().int().nonnegative().max(65536),
});
/** Shared raw storage owner. Chunks commit in the same transaction as provider cursors. */
export class StreamingBlobs {
  constructor(statement: (sql: string) => StatementSync) {
    this.statement = statement;
  }
  private statement: (sql: string) => StatementSync;
  append(threadId: ThreadId, input: unknown): void {
    const part = Part.parse(input);
    const select = this.statement("SELECT * FROM streamed_blobs WHERE id=?");
    let row = select.get(part.id);
    if (!row) {
      if (part.offset !== 0 || part.done) return;
      if (
        Number(
          this.statement(
            "SELECT COUNT(*) AS count FROM streamed_blobs WHERE thread_id=? AND sha256 IS NULL",
          ).get(threadId)?.count,
        ) >= 8
      )
        return;
      this.statement(
        "INSERT INTO streamed_blobs(id,thread_id,size,sha256,storage_id) VALUES(?,?,0,NULL,?)",
      ).run(part.id, threadId, part.id);
      row = select.get(part.id);
    }
    const head = Head.parse(row);
    if (head.thread_id !== threadId || head.sha256 || head.size !== part.offset)
      throw new Error("Raw blob stream scope or position conflict");
    if (part.text !== undefined) {
      if (part.done) throw new Error("Raw blob completion also contained data");
      const bytes = Buffer.from(part.text);
      if (
        !bytes.length ||
        bytes.length > 65536 ||
        head.size + bytes.length > 16777216 ||
        head.chunks >= 65536
      )
        throw new Error("Raw blob chunk exceeds budget");
      this.statement("INSERT INTO streamed_blob_chunks VALUES(?,?,?)").run(
        part.id,
        head.size,
        bytes,
      );
      this.statement("UPDATE streamed_blobs SET size=size+?,chunks=chunks+1 WHERE id=?").run(
        bytes.length,
        part.id,
      );
    } else if (part.done) {
      const hash = createHash("sha256");
      let offset = 0;
      for (const chunk of this.statement(
        "SELECT offset,bytes FROM streamed_blob_chunks WHERE blob_id=? ORDER BY offset",
      ).iterate(part.id)) {
        if (Number(chunk.offset) !== offset || !(chunk.bytes instanceof Uint8Array))
          throw new Error("Raw blob is incomplete");
        hash.update(chunk.bytes);
        offset += chunk.bytes.length;
      }
      if (offset !== head.size) throw new Error("Raw blob size mismatch");
      const sha = hash.digest("hex");
      const duplicate = this.statement(
        "SELECT storage_id FROM streamed_blobs WHERE thread_id=? AND sha256=? AND storage_id=id LIMIT 1",
      ).get(threadId, sha);
      if (duplicate) {
        this.statement("UPDATE streamed_blobs SET sha256=?,storage_id=? WHERE id=?").run(
          sha,
          String(duplicate.storage_id),
          part.id,
        );
        this.statement("DELETE FROM streamed_blob_chunks WHERE blob_id=?").run(part.id);
      } else this.statement("UPDATE streamed_blobs SET sha256=? WHERE id=?").run(sha, part.id);
    } else throw new Error("Raw blob chunk has no content");
  }
  info(id: string) {
    const row = this.statement("SELECT * FROM streamed_blobs WHERE id=?").get(id);
    if (!row) return undefined;
    const head = Head.parse(row);
    if (!head.sha256) throw new Error("Raw blob not committed");
    return { threadId: head.thread_id, size: head.size, sha256: head.sha256 };
  }
  read(id: string, offset: number, limit: number): Uint8Array {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 65536
    )
      throw new Error("Invalid raw blob range");
    const head = Head.parse(this.statement("SELECT * FROM streamed_blobs WHERE id=?").get(id));
    if (!head.sha256) throw new Error("Raw blob not committed");
    const start = this.statement(
      "SELECT offset FROM streamed_blob_chunks WHERE blob_id=? AND offset<=? ORDER BY offset DESC LIMIT 1",
    ).get(head.storage_id, offset);
    const end = Math.min(head.size, offset + limit);
    const chunks = this.statement(
      "SELECT offset,bytes FROM streamed_blob_chunks WHERE blob_id=? AND offset>=? AND offset<? ORDER BY offset",
    ).all(head.storage_id, Number(start?.offset ?? offset), end);
    const output = Buffer.alloc(Math.max(0, end - offset));
    for (const chunk of chunks) {
      if (!(chunk.bytes instanceof Uint8Array)) throw new Error("Invalid raw blob chunk");
      const position = Number(chunk.offset),
        from = Math.max(0, offset - position),
        to = Math.max(0, position - offset);
      output.set(chunk.bytes.subarray(from, Math.min(chunk.bytes.length, end - position)), to);
    }
    return output;
  }
}
