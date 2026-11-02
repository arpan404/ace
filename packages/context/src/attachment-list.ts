import { z } from "zod";
import { Attachment, attachmentPageMax, type ContextOperation } from "@ace/protocol";
import { requireContext } from "./errors.ts";
import type { Metadata } from "./metadata.ts";

/*
 * A thread's stored files, read from the `refs` table. Insertion order (the row id) is the
 * file's age, so pages run newest first and a cursor is the last row id a page returned: files
 * added or removed between pages never shift or repeat the rest of the list.
 */

const Row = z.object({ id: z.number(), metadata: z.string(), name: z.string() });
const cursorPattern = /^[1-9]\d{0,15}$/;

function attachment(row: z.infer<typeof Row>): Attachment {
  return Attachment.parse({ ...Attachment.parse(JSON.parse(row.metadata)), name: row.name });
}

/** One page of a thread's files, newest first, with the cursor for the next page if any. */
export function listAttachmentPage(
  metadata: Metadata,
  op: Extract<ContextOperation, { op: "attachment.list" }>,
): { kind: "attachments"; attachments: Attachment[]; nextCursor?: string } {
  requireContext(
    op.cursor === undefined || cursorPattern.test(op.cursor),
    "invalid_request",
    "The attachment list moved on. Close Attachments and open it again.",
  );
  const limit = op.limit ?? attachmentPageMax;
  const rows = metadata
    .all(
      `SELECT r.rowid AS id,b.metadata,r.name FROM refs r JOIN blobs b USING(sha256)
       WHERE r.thread=? AND r.rowid<? ORDER BY r.rowid DESC LIMIT ?`,
      op.threadId,
      op.cursor === undefined ? Number.MAX_SAFE_INTEGER : Number(op.cursor),
      limit + 1,
    )
    .map((row) => Row.parse(row));
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    kind: "attachments",
    attachments: page.map(attachment),
    ...(rows.length > limit && last ? { nextCursor: String(last.id) } : {}),
  };
}

/** Every file a scope holds, oldest first. Internal sweeps only; never sent on the wire. */
export function allAttachments(metadata: Metadata, thread: string): Attachment[] {
  return metadata
    .all(
      "SELECT r.rowid AS id,b.metadata,r.name FROM refs r JOIN blobs b USING(sha256) WHERE r.thread=? ORDER BY r.rowid",
      thread,
    )
    .map((row) => attachment(Row.parse(row)));
}
