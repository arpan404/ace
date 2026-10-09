import type { DatabaseSync } from "node:sqlite";
import type { ArchiveReader } from "@ace/history-import";
import type { EventPayload } from "@ace/protocol";

/** Called only in the publication worker while its event-store transaction is private. */
export function installArchive(
  db: DatabaseSync,
  archive: ArchiveReader,
  append: (payload: EventPayload) => void,
  cancelled: () => boolean,
) {
  const check = () => {
    if (cancelled()) throw new Error("History publication cancelled");
  };
  append({
    type: "thread.created",
    thread: {
      ...archive.thread,
      status: { state: "done" },
      settledAt: archive.thread.updatedAt,
      settledReason: "manual",
      unread: false,
    },
  });
  for (const agent of archive.agents()) {
    check();
    append({ type: "agent.created", agent });
  }
  const output = db.prepare(
    "INSERT INTO output_streams(id,thread_id,item_id,size) VALUES(?,?,?,0)",
  );
  for (const item of archive.items()) {
    check();
    append({ type: "item.created", item });
    if (item.type === "tool_call" && item.call.detail.kind === "shell" && item.call.detail.output)
      output.run(item.call.detail.output.streamId, archive.thread.id, item.id);
  }
  const stream = db.prepare("SELECT id FROM output_streams WHERE id=? AND thread_id=?");
  const raw = db.prepare("INSERT INTO history_blobs VALUES(?,?,?)");
  const outputChunk = db.prepare("INSERT INTO output_chunks VALUES(?,?,?)");
  const rawChunk = db.prepare("INSERT INTO history_blob_chunks VALUES(?,?,?)");
  const updateStream = db.prepare("UPDATE output_streams SET size=? WHERE id=?");
  for (const blob of archive.blobs()) {
    check();
    const isOutput = Boolean(stream.get(blob.id, archive.thread.id));
    if (!isOutput) raw.run(blob.id, archive.thread.id, blob.size);
    let offset = 0;
    for (const bytes of blob.chunks()) {
      check();
      (isOutput ? outputChunk : rawChunk).run(blob.id, offset, bytes);
      offset += bytes.byteLength;
    }
    if (offset !== blob.size) throw new Error("Incomplete history blob");
    if (isOutput) updateStream.run(offset, blob.id);
  }
  check();
}

export function readHistoryBlob(
  db: DatabaseSync,
  threadId: string,
  id: string,
  offset: number,
  limit: number,
) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 256 * 1024
  )
    throw new Error("Invalid history blob range");
  const row = db
    .prepare("SELECT size FROM history_blobs WHERE id=? AND thread_id=?")
    .get(id, threadId);
  if (!row) throw new Error("Unknown history blob");
  const size = Number(row.size),
    bytes = Buffer.alloc(Math.min(limit, Math.max(0, size - offset)));
  for (const chunk of db
    .prepare(
      "SELECT offset,bytes FROM history_blob_chunks WHERE blob_id=? AND offset>=? AND offset<? ORDER BY offset",
    )
    .iterate(id, Math.max(0, offset - 64 * 1024), offset + bytes.length)) {
    if (!(chunk.bytes instanceof Uint8Array)) throw new Error("Invalid history blob chunk");
    const start = Number(chunk.offset),
      from = Math.max(0, offset - start),
      target = Math.max(0, start - offset);
    bytes.set(
      chunk.bytes.subarray(from, Math.min(chunk.bytes.length, offset + bytes.length - start)),
      target,
    );
  }
  return { bytes, size };
}
