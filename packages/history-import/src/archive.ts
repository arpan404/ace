import type { DatabaseSync, StatementSync } from "node:sqlite";
import { Thread } from "@ace/protocol/entities";
import { z } from "zod";
import { ArchiveCommand, PageRequest, BlobRequest } from "./archive-contracts.ts";

/** All calls run inside the history worker. Staging rows stay invisible across crashes. */
export class Archive {
  private db: DatabaseSync;
  private thread: string | undefined;
  private seq = 0;
  private blob: { id: string; expected: number; offset: number } | undefined;
  private statements = new Map<string, StatementSync>();
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS imported_threads(id TEXT PRIMARY KEY,source TEXT UNIQUE NOT NULL,thread TEXT NOT NULL,published INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS imported_agents(id TEXT PRIMARY KEY,thread TEXT NOT NULL REFERENCES imported_threads(id) ON DELETE CASCADE,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS imported_items(thread TEXT NOT NULL REFERENCES imported_threads(id) ON DELETE CASCADE,seq INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(thread,seq));
      CREATE TABLE IF NOT EXISTS imported_blobs(id TEXT PRIMARY KEY,thread TEXT NOT NULL REFERENCES imported_threads(id) ON DELETE CASCADE,size INTEGER NOT NULL,complete INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS imported_blob_chunks(blob TEXT NOT NULL REFERENCES imported_blobs(id) ON DELETE CASCADE,offset INTEGER NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(blob,offset));
      DELETE FROM imported_threads WHERE published=0;`);
  }
  private stmt(sql: string) {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }
  write(input: z.infer<typeof ArchiveCommand>) {
    const cmd = ArchiveCommand.parse(input);
    if (cmd.type === "begin") {
      if (this.thread) throw new Error("Archive import already active");
      const provenance = cmd.thread.imported;
      if (!provenance) throw new Error("Missing import provenance");
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.stmt("INSERT INTO imported_threads VALUES(?,?,?,0)").run(
          cmd.thread.id,
          provenance.sourceId,
          JSON.stringify(cmd.thread),
        );
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      this.thread = cmd.thread.id;
      this.seq = 0;
      return;
    }
    if (cmd.type === "rollback") {
      if (this.thread) this.db.exec("ROLLBACK");
      this.thread = undefined;
      this.blob = undefined;
      return;
    }
    if (!this.thread) throw new Error("No archive import active");
    if (cmd.type === "agent")
      this.stmt("INSERT INTO imported_agents VALUES(?,?,?)").run(
        cmd.agent.id,
        this.thread,
        JSON.stringify(cmd.agent),
      );
    else if (cmd.type === "item") {
      if (Buffer.byteLength(JSON.stringify(cmd.item)) > 256 * 1024)
        throw new Error("Canonical history item exceeds publication limit");
      this.stmt("INSERT INTO imported_items VALUES(?,?,?)").run(
        this.thread,
        ++this.seq,
        JSON.stringify(cmd.item),
      );
    } else if (cmd.type === "blob.start") {
      if (this.blob) throw new Error("Blob stream already open");
      this.stmt("INSERT INTO imported_blobs VALUES(?,?,?,0)").run(cmd.id, this.thread, cmd.bytes);
      this.blob = { id: cmd.id, expected: cmd.bytes, offset: 0 };
    } else if (cmd.type === "blob.chunk") {
      const b = this.blob;
      if (!b || b.id !== cmd.id || b.offset + cmd.bytes.byteLength > b.expected)
        throw new Error("Invalid blob chunk");
      this.stmt("INSERT INTO imported_blob_chunks VALUES(?,?,?)").run(b.id, b.offset, cmd.bytes);
      b.offset += cmd.bytes.byteLength;
    } else if (cmd.type === "blob.end") {
      if (!this.blob || this.blob.id !== cmd.id || this.blob.offset !== this.blob.expected)
        throw new Error("Incomplete blob");
      this.stmt("UPDATE imported_blobs SET complete=1 WHERE id=?").run(cmd.id);
      this.blob = undefined;
    } else if (cmd.type === "commit") {
      if (this.blob) throw new Error("Cannot publish an incomplete blob");
      this.stmt("UPDATE imported_threads SET published=1 WHERE id=?").run(this.thread);
      this.db.exec("COMMIT");
      this.thread = undefined;
    }
  }
  delete(id: string) {
    if (this.thread) throw new Error("Archive import active");
    this.stmt("DELETE FROM imported_threads WHERE id=?").run(id);
  }
  find(source: string) {
    const row = this.stmt("SELECT thread FROM imported_threads WHERE source=? AND published=1").get(
      source,
    );
    return row ? Thread.parse(JSON.parse(String(row.thread))) : null;
  }
  get(id: string) {
    const row = this.stmt("SELECT thread FROM imported_threads WHERE id=? AND published=1").get(id);
    return row ? Thread.parse(JSON.parse(String(row.thread))) : null;
  }
  agents(id: string) {
    if (!this.get(id)) return [];
    return this.stmt("SELECT data FROM imported_agents WHERE thread=? ORDER BY id LIMIT 512")
      .all(id)
      .map((r) => JSON.parse(String(r.data)));
  }
  page(input: z.infer<typeof PageRequest>) {
    const p = PageRequest.parse(input);
    if (!this.get(p.threadId)) throw new Error("Unknown imported thread");
    const items: unknown[] = [];
    let bytes = 0;
    let cursor = p.after;
    let more = false;
    for (const row of this.stmt(
      "SELECT seq,data FROM imported_items WHERE thread=? AND seq>? ORDER BY seq LIMIT ?",
    ).iterate(p.threadId, p.after, p.limit + 1)) {
      const data = String(row.data);
      if (Buffer.byteLength(data) > 1024 * 1024) throw new Error("Stored item exceeds page limit");
      if (items.length >= p.limit || bytes + Buffer.byteLength(data) > 1024 * 1024) {
        more = true;
        break;
      }
      items.push(JSON.parse(data));
      bytes += Buffer.byteLength(data);
      cursor = Number(row.seq);
    }
    return { items, next: more ? cursor : null };
  }
  readBlob(input: z.infer<typeof BlobRequest>) {
    const p = BlobRequest.parse(input);
    const row = this.stmt(
      "SELECT b.size FROM imported_blobs b JOIN imported_threads t ON t.id=b.thread WHERE b.id=? AND b.complete=1 AND t.published=1",
    ).get(p.id);
    if (!row) throw new Error("Unknown imported blob");
    const size = Number(row.size);
    const bytes = Buffer.alloc(Math.min(p.limit, Math.max(0, size - p.offset)));
    // Chunks are <=64 KiB. A bounded range starts no earlier than the preceding chunk.
    for (const chunk of this.stmt(
      "SELECT offset,bytes FROM imported_blob_chunks WHERE blob=? AND offset>=? AND offset<? ORDER BY offset",
    ).iterate(p.id, Math.max(0, p.offset - 64 * 1024), p.offset + bytes.length)) {
      if (!(chunk.bytes instanceof Uint8Array)) throw new Error("Invalid archive blob");
      const start = Number(chunk.offset);
      const from = Math.max(0, p.offset - start);
      const target = Math.max(0, start - p.offset);
      bytes.set(
        chunk.bytes.subarray(from, Math.min(chunk.bytes.length, p.offset + bytes.length - start)),
        target,
      );
    }
    return { bytes, size };
  }
}
