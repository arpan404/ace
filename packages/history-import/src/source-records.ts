import { hasOpenCodeV2, supportsOpenCodeV2, openCodeV2Records } from "./opencode-messages.ts";
import { orderedMessages, orderedParts } from "./storage-order.ts";
import { basename, join } from "node:path";
import { readJsonLines, readRange, object, string, RECORD_LIMIT } from "@ace/native-session";
import type { ProviderHome } from "./contracts.ts";
import type { Source } from "./catalog.ts";
import { openProviderDb, supportsOpenCode } from "./provider-db.ts";

export type HistoryRecord =
  | { value: unknown; bytes: number; chunks: () => AsyncGenerator<Uint8Array> }
  | { opaque: true; bytes: number; chunks: () => AsyncGenerator<Uint8Array> };
export async function* sourceRecords(
  instance: ProviderHome,
  source: Source,
  signal: AbortSignal,
  scratchRoot: string,
): AsyncGenerator<HistoryRecord> {
  if (source.kind === "jsonl") {
    for await (const record of readJsonLines(instance.homeDir, source.path, signal)) {
      const chunks = () =>
        readRange(instance.homeDir, source.path, record.offset, record.bytes, signal);
      yield "value" in record
        ? { value: record.value, bytes: record.bytes, chunks }
        : { opaque: true, bytes: record.bytes, chunks };
    }
    return;
  }
  if (source.kind === "storage") {
    for await (const header of orderedMessages(
      instance,
      join(instance.homeDir, "storage/message", source.summary.nativeId),
      scratchRoot,
      signal,
    )) {
      const messagePath = header.path;
      const message = object(header.value);
      yield {
        value: header.value,
        bytes: header.bytes,
        chunks: () => readRange(instance.homeDir, messagePath, 0, header.bytes, signal),
      };
      for await (const part of orderedParts(
        join(instance.homeDir, "storage/part", basename(messagePath, ".json")),
        scratchRoot,
        signal,
      )) {
        for await (const record of readJsonLines(instance.homeDir, part, signal)) {
          const chunks = () =>
            readRange(instance.homeDir, part, record.offset, record.bytes, signal);
          if ("value" in record)
            yield {
              value: { ...object(record.value), role: string(message.role) },
              bytes: record.bytes,
              chunks,
            };
          else yield { opaque: true, bytes: record.bytes, chunks };
        }
      }
    }
    return;
  }
  const handle = await openProviderDb(instance, source.path, scratchRoot, signal);
  const db = handle.db;
  try {
    if (!supportsOpenCode(db)) throw new Error("Unsupported provider database history");
    if (hasOpenCodeV2(db, source.summary.nativeId)) {
      if (!supportsOpenCodeV2(db)) throw new Error("Unsupported OpenCode history format");
      yield* openCodeV2Records(db, source.summary.nativeId, signal);
      return;
    }
    db.exec("BEGIN"); // Consistent read-only snapshot, including live WAL.
    const rows = db.prepare(
      "SELECT id,octet_length(data) AS bytes FROM message WHERE session_id=? ORDER BY time_created,id",
    );
    const parts = db.prepare(
      "SELECT id,octet_length(data) AS bytes FROM part WHERE message_id=? ORDER BY id",
    );
    const messageChunk = db.prepare(
      "SELECT substr(CAST(data AS BLOB),?,?) AS chunk FROM message WHERE id=?",
    );
    const partChunk = db.prepare(
      "SELECT substr(CAST(data AS BLOB),?,?) AS chunk FROM part WHERE id=?",
    );
    const read = async function* (
      table: "message" | "part",
      id: string,
      bytes: number,
    ): AsyncGenerator<Uint8Array> {
      const stmt = table === "message" ? messageChunk : partChunk;
      for (let offset = 0; offset < bytes; offset += 64 * 1024) {
        signal.throwIfAborted();
        const row = stmt.get(offset + 1, Math.min(64 * 1024, bytes - offset), id);
        if (!(row?.chunk instanceof Uint8Array)) throw new Error("Invalid SQLite history chunk");
        yield row.chunk;
      }
    };
    for (const row of rows.iterate(source.summary.nativeId)) {
      signal.throwIfAborted();
      const id = String(row.id);
      const bytes = Number(row.bytes);
      const chunks = () => read("message", id, bytes);
      let role: string | undefined;
      if (bytes > RECORD_LIMIT)
        throw new Error("OpenCode SQLite record exceeds bounded decoder limit");
      else {
        const buffers: Uint8Array[] = [];
        for await (const chunk of chunks()) buffers.push(chunk);
        try {
          const value: unknown = JSON.parse(Buffer.concat(buffers).toString("utf8"));
          role = string(object(value).role);
          yield { value: { ...object(value), id }, bytes, chunks };
        } catch {
          yield { opaque: true, bytes, chunks };
        }
      }
      for (const part of parts.iterate(id)) {
        const partId = String(part.id);
        const size = Number(part.bytes);
        const partChunks = () => read("part", partId, size);
        if (size > RECORD_LIMIT)
          throw new Error("OpenCode SQLite record exceeds bounded decoder limit");
        else {
          const buffers: Uint8Array[] = [];
          for await (const chunk of partChunks()) buffers.push(chunk);
          try {
            yield {
              value: {
                ...object(JSON.parse(Buffer.concat(buffers).toString("utf8"))),
                role,
                id: partId,
                messageID: id,
              },
              bytes: size,
              chunks: partChunks,
            };
          } catch {
            yield { opaque: true, bytes: size, chunks: partChunks };
          }
        }
      }
    }
  } finally {
    await handle.close();
  }
}
