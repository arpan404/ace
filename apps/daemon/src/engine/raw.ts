import { createHash } from "node:crypto";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { Fact } from "@ace/core";
import type { RawPayload } from "@ace/protocol";

const blobId = z.string().regex(/^[a-f0-9]{64}$/);
/** Temporary data envelope until ADR 0006's protocol blob-ref form lands. */
export function capRaw(db: DatabaseSync, raw: RawPayload[]): RawPayload[] {
  return raw.map((entry) => {
    const json = JSON.stringify(entry.data);
    if (json === undefined) return entry;
    const bytes = Buffer.from(json);
    if (bytes.length <= 64 * 1024) return entry;
    const id = createHash("sha256").update(bytes).digest("hex");
    db.prepare("INSERT OR IGNORE INTO engine_raw_blobs VALUES (?, ?)").run(id, bytes);
    return {
      ...entry,
      data: {
        aceRawBlob: { id, size: bytes.length, preview: bytes.subarray(0, 2048).toString("utf8") },
      },
    };
  });
}
export function capFact(db: DatabaseSync, fact: Fact): Fact {
  if (fact.type === "item.upsert" && fact.draft.type === "tool_call" && fact.draft.call?.raw)
    return {
      ...fact,
      draft: { ...fact.draft, call: { ...fact.draft.call, raw: capRaw(db, fact.draft.call.raw) } },
    };
  if (fact.type === "item.upsert" && "raw" in fact.draft && fact.draft.raw)
    return { ...fact, draft: { ...fact.draft, raw: capRaw(db, fact.draft.raw) } };
  if ((fact.type === "interaction.opened" || fact.type === "background.started") && fact.raw)
    return { ...fact, raw: capRaw(db, fact.raw) };
  return fact;
}
export function readRawBlob(db: DatabaseSync, id: string): Uint8Array | undefined {
  const row = db.prepare("SELECT bytes FROM engine_raw_blobs WHERE id=?").get(blobId.parse(id));
  const value = row?.bytes;
  if (value === undefined) return undefined;
  if (!(value instanceof Uint8Array)) throw new Error("Invalid stored raw blob");
  return value;
}
