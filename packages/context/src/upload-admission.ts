import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ContextOperation, ContextResult } from "@ace/protocol";
import { requireContext } from "./errors.ts";
import { Metadata } from "./metadata.ts";
import type { UploadOptions, UploadLimits } from "./upload-options.ts";

const UploadCount = z.object({ count: z.number() });

/** A byte limit as people read it: whole MiB or GiB. */
export function formatLimit(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${Number.isInteger(gib) ? gib : gib.toFixed(1)} GiB`;
  const mib = bytes / 1024 ** 2;
  if (mib >= 1) return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB`;
  return `${bytes} byte${bytes === 1 ? "" : "s"}`;
}

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
    `This file is larger than the ${formatLimit(limits.fileBytes)} limit for one attachment. Choose a smaller file, or raise ACE_ATTACHMENT_FILE_BYTES and restart ace.`,
  );
  // A thread may hold any number of files. Only the whole store is bounded, so attachments can't
  // fill the disk.
  const occupied = metadata.storage(),
    global = metadata.usage("*");
  requireContext(
    global.bytes + op.bytes <= limits.globalBytes &&
      occupied.bytes + op.bytes <= limits.globalBytes &&
      occupied.count < limits.globalEntries &&
      global.count < limits.globalEntries,
    "quota",
    `ace's attachment storage is full (${formatLimit(limits.globalBytes)} across all threads), which keeps files from filling your disk. Free space in Settings > Storage or delete threads you no longer need, then try again.`,
  );
  const count = UploadCount.parse(metadata.get("SELECT COUNT(*) AS count FROM uploads"));
  requireContext(
    count.count < limits.uploads,
    "quota",
    "Too many uploads are in progress. Wait for them to finish, then try again.",
  );
  const id = z
    .string()
    .regex(/^[\w-]{1,128}$/)
    .parse(options.id());
  const file = await open(join(options.root, "uploads", id), "wx", 0o600);
  await file.close();
  const directory = await open(join(options.root, "uploads"), "r");
  // Windows can't flush a directory handle (EPERM); NTFS journals the new directory entry itself.
  if (process.platform === "win32") Object.assign(directory, { sync: async () => {} });
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
