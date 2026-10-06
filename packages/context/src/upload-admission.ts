import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ContextOperation, ContextResult } from "@ace/protocol";
import { requireContext } from "./errors.ts";
import { Metadata } from "./metadata.ts";
import type { UploadOptions, UploadLimits } from "./upload-options.ts";

export async function beginUpload(
  metadata: Metadata,
  options: UploadOptions,
  limits: UploadLimits,
  device: string,
  op: Extract<ContextOperation, { op: "upload.begin" }>,
): Promise<ContextResult["result"]> {
  requireContext(
    op.bytes <= limits.fileBytes,
    "quota",
    `File exceeds the ${limits.fileBytes} byte attachment limit. Choose a smaller file or increase ACE_ATTACHMENT_FILE_BYTES.`,
  );
  const occupied = metadata.storage();
  const thread = metadata.usage(op.threadId),
    global = metadata.usage("*");
  requireContext(
    thread.bytes + op.bytes <= limits.threadBytes &&
      global.bytes + op.bytes <= limits.globalBytes &&
      occupied.bytes + op.bytes <= limits.globalBytes &&
      occupied.count < limits.globalEntries &&
      thread.count < limits.threadEntries &&
      global.count < limits.globalEntries,
    "quota",
    "Attachment storage is full. Delete older threads or remove unused attachments, then retry.",
  );
  const count = z
    .object({ count: z.number() })
    .parse(metadata.get("SELECT COUNT(*) AS count FROM uploads"));
  requireContext(count.count < limits.uploads, "quota", "Upload reservation limit reached");
  const id = z
    .string()
    .regex(/^[\w-]{1,128}$/)
    .parse(options.id());
  const file = await open(join(options.root, "uploads", id), "wx", 0o600);
  await file.close();
  const directory = await open(join(options.root, "uploads"), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  try {
    metadata.transaction(() => {
      metadata.run(
        "INSERT INTO uploads(id,device,thread,sha256,bytes,name,offset,expires,done,mime_type) VALUES(?,?,?,?,?,?,0,?,0,?)",
        id,
        device,
        op.threadId,
        op.sha256,
        op.bytes,
        op.name,
        options.now() + limits.ttlMs,
        op.mimeType ?? null,
      );
      metadata.adjust(op.threadId, op.bytes, 1);
      metadata.adjustStorage(op.bytes, 1);
    });
  } catch (error) {
    await rm(join(options.root, "uploads", id), { force: true });
    throw error;
  }
  return { kind: "upload", uploadId: id, offset: 0, bytes: op.bytes };
}
