import { createHash } from "node:crypto";
import { PinnedDirectory } from "@ace/workspace";
import { z } from "zod";
import { BlobHash } from "@ace/protocol";
import { mediaExtension } from "./attachment-bytes.ts";
import { requireContext } from "./errors.ts";
import type { Metadata } from "./metadata.ts";

export interface AttachmentCleanupEntry {
  hash: string;
  bytes: number;
  modifiedAt: number;
  fingerprint: string;
  referenced: boolean;
  leased: boolean;
  pending: boolean;
}
const Identity = z.object({
  dev: z.number(),
  ino: z.number(),
  size: z.number(),
  mtime: z.number(),
  ctime: z.number(),
});
const Removal = z.object({
  fingerprint: z.string(),
  original: Identity,
  alias: z.string().optional(),
  aliasIdentity: Identity.optional(),
});
function identity(directory: PinnedDirectory, hash: string) {
  const file = directory.fileMetadata(hash);
  return {
    dev: file.dev,
    ino: file.ino,
    size: file.size,
    mtime: file.mtimeMs,
    ctime: file.ctimeMs,
  };
}
const absent = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
function protectedBlob(metadata: Metadata, hash: string) {
  return {
    referenced: Boolean(metadata.get("SELECT 1 FROM refs WHERE sha256=? LIMIT 1", hash)),
    leased: Boolean(metadata.get("SELECT 1 FROM leases WHERE sha256=? LIMIT 1", hash)),
    pending: Boolean(metadata.get("SELECT 1 FROM uploads WHERE sha256=? AND done=0 LIMIT 1", hash)),
  };
}
function inspect(
  metadata: Metadata,
  directory: PinnedDirectory,
  hash: string,
): AttachmentCleanupEntry {
  const info = identity(directory, BlobHash.parse(hash));
  const protection = protectedBlob(metadata, hash);
  const blob = metadata.blob(hash);
  const alias =
    blob && mediaExtension(blob.mimeType) ? hash + mediaExtension(blob.mimeType) : undefined;
  let aliasIdentity: z.infer<typeof Identity> | undefined;
  if (alias) {
    try {
      aliasIdentity = identity(directory, alias);
    } catch (error) {
      if (!absent(error)) throw error;
    }
  }
  return {
    hash,
    bytes: info.size,
    modifiedAt: Math.floor(
      Math.max(
        info.mtime,
        Number(metadata.get("SELECT changed FROM blob_retention WHERE hash=?", hash)?.changed ?? 0),
      ),
    ),
    ...protection,
    fingerprint: createHash("sha256")
      .update(JSON.stringify({ info, protection, blob, aliasIdentity }))
      .digest("hex"),
  };
}
function withDirectory<T>(root: string, work: (directory: PinnedDirectory) => T): T {
  const pinned = PinnedDirectory.atBoundary(root);
  try {
    const directory = pinned.child("blobs");
    try {
      return work(directory);
    } finally {
      directory.closeSync();
    }
  } finally {
    pinned.closeSync();
  }
}
/** Inside UploadStore's serializer, shared with commit, reads and leases. */
export async function inspectAttachmentCleanup(
  metadata: Metadata,
  root: string,
  hash: string,
): Promise<AttachmentCleanupEntry> {
  return withDirectory(root, (directory) => inspect(metadata, directory, hash));
}
function unlinkReviewed(
  directory: PinnedDirectory,
  name: string,
  expected: z.infer<typeof Identity>,
): void {
  try {
    const current = identity(directory, name);
    // Unlinking a hard link changes ctime on its sibling, so identity/size/mtime fence the alias.
    requireContext(
      current.dev === expected.dev &&
        current.ino === expected.ino &&
        current.size === expected.size &&
        current.mtime === expected.mtime,
      "busy",
      "Attachment cleanup path changed",
    );
    directory.unlink(name);
  } catch (error) {
    if (!absent(error)) throw error;
  }
}
export async function removeAttachmentCleanup(
  metadata: Metadata,
  root: string,
  hash: string,
  fingerprint: string,
): Promise<void> {
  BlobHash.parse(hash);
  withDirectory(root, (directory) => {
    const protection = protectedBlob(metadata, hash);
    requireContext(!Object.values(protection).some(Boolean), "busy", "Attachment is protected");
    const existing = metadata.get(
      "SELECT record FROM attachment_cleanup WHERE hash=?",
      hash,
    )?.record;
    let removal: z.infer<typeof Removal>;
    if (typeof existing === "string") {
      removal = Removal.parse(JSON.parse(existing));
      requireContext(removal.fingerprint === fingerprint, "busy", "Another plan owns this blob");
    } else {
      let entry: AttachmentCleanupEntry;
      try {
        entry = inspect(metadata, directory, hash);
      } catch (error) {
        if (absent(error) && !metadata.blob(hash)) return;
        throw error;
      }
      requireContext(entry.fingerprint === fingerprint, "busy", "Attachment cleanup plan changed");
      const blob = metadata.blob(hash);
      const alias =
        blob && mediaExtension(blob.mimeType) ? hash + mediaExtension(blob.mimeType) : undefined;
      let aliasIdentity: z.infer<typeof Identity> | undefined;
      if (alias) {
        try {
          aliasIdentity = identity(directory, alias);
        } catch (error) {
          if (!absent(error)) throw error;
        }
      }
      removal = {
        fingerprint,
        original: identity(directory, hash),
        ...(alias ? { alias } : {}),
        ...(aliasIdentity ? { aliasIdentity } : {}),
      };
      metadata.transaction(() =>
        metadata.run("INSERT INTO attachment_cleanup VALUES (?,?)", hash, JSON.stringify(removal)),
      );
    }
    try {
      const original = identity(directory, hash);
      requireContext(
        original.ctime === removal.original.ctime,
        "busy",
        "Attachment changed after review",
      );
    } catch (error) {
      if (!absent(error)) throw error;
    }
    // Durable exact identities precede both unlinks. No await can admit a competing commit.
    unlinkReviewed(directory, hash, removal.original);
    if (removal.alias && removal.aliasIdentity)
      unlinkReviewed(directory, removal.alias, removal.aliasIdentity);
    const blob = metadata.blob(hash);
    metadata.transaction(() => {
      metadata.run("DELETE FROM blobs WHERE sha256=? AND refs=0", hash);
      if (blob) metadata.adjustStorage(-blob.bytes, -1);
      metadata.run("DELETE FROM blob_retention WHERE hash=?", hash);
      metadata.run("DELETE FROM attachment_cleanup WHERE hash=?", hash);
    });
  });
}
export async function resumeAttachmentCleanup(metadata: Metadata, root: string): Promise<void> {
  for (const row of metadata.all("SELECT hash,record FROM attachment_cleanup LIMIT 256")) {
    const record = Removal.parse(JSON.parse(z.string().parse(row.record)));
    await removeAttachmentCleanup(metadata, root, BlobHash.parse(row.hash), record.fingerprint);
  }
}
