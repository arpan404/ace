import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { Thread, Agent, Item } from "@ace/protocol/entities";
import { z } from "zod";

const BlobHeader = z.object({ id: z.string(), size: z.number().int().nonnegative() });
/** ace-owned archives only. Streaming reader for a transactional engine-store publisher. */
export function openArchiveReader(path: string, threadId: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const threadRow = db
      .prepare("SELECT thread FROM imported_threads WHERE id=? AND published=1")
      .get(threadId);
    if (!threadRow) throw new Error("Unknown imported thread");
    const thread = Thread.parse(JSON.parse(String(threadRow.thread)));
    return {
      thread,
      *agents() {
        for (const r of db
          .prepare("SELECT data FROM imported_agents WHERE thread=? ORDER BY id")
          .iterate(threadId))
          yield Agent.parse(JSON.parse(String(r.data)));
      },
      *items() {
        for (const r of db
          .prepare("SELECT data FROM imported_items WHERE thread=? ORDER BY seq")
          .iterate(threadId))
          yield Item.parse(JSON.parse(String(r.data)));
      },
      *blobs() {
        for (const row of db
          .prepare("SELECT id,size FROM imported_blobs WHERE thread=? AND complete=1")
          .iterate(threadId)) {
          const header = BlobHeader.parse(row);
          yield {
            ...header,
            *chunks() {
              for (const r of db
                .prepare("SELECT bytes FROM imported_blob_chunks WHERE blob=? ORDER BY offset")
                .iterate(header.id)) {
                if (!(r.bytes instanceof Uint8Array) || r.bytes.byteLength > 64 * 1024)
                  throw new Error("Invalid archive blob chunk");
                yield r.bytes;
              }
            },
          };
        }
      },
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
export type ArchiveReader = ReturnType<typeof openArchiveReader>;
