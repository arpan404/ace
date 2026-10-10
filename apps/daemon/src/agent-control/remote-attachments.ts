import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { ContextService } from "@ace/context";
import type { ThreadId, RemoteContextManifest } from "@ace/protocol";
import type { FilesWorkspaces } from "../files-workspaces.ts";
const owner = "ace-remote-context";
/** Freeze bytes once; direction-specific owners authorize selection and retain the result. */
export async function freezeRemoteAttachments(
  options: {
    context?: ContextService | undefined;
    files?: FilesWorkspaces | undefined;
    retain?: (hash: string) => void;
  },
  threadId: ThreadId,
  selection: { attachments: readonly string[]; files: readonly string[] } | undefined,
  signal: AbortSignal,
): Promise<RemoteContextManifest["attachments"]> {
  const attachments: RemoteContextManifest["attachments"] = [];

  const context = options.context;
  let total = 0;
  const add = (attachment: RemoteContextManifest["attachments"][number]) => {
    const existing = attachments.find((candidate) => candidate.sha256 === attachment.sha256);
    if (existing) {
      existing.aliases = [
        ...new Set([
          ...(existing.aliases ?? []),
          existing.sourcePath ?? existing.name,
          attachment.sourcePath ?? attachment.name,
        ]),
      ];
      return;
    }
    total += attachment.bytes;
    if (attachment.bytes > 32 * 1024 * 1024 || total > 128 * 1024 * 1024)
      throw new Error("Remote context byte budget exceeded");
    attachments.push(attachment);
  };
  for (const sha256 of selection?.attachments ?? []) {
    signal.throwIfAborted();
    if (!context) throw new Error("Attachment context unavailable");
    const blob = await context.uploads.attachment(owner, threadId, sha256);
    add(blob.attachment);
  }
  for (const path of selection?.files ?? []) {
    signal.throwIfAborted();
    if (!context || !options.files) throw new Error("Source workspace files unavailable");
    const download = await (
      await options.files.get(threadId)
    ).download(owner, { op: "download", path, offset: 0 });
    try {
      if (
        download.size === null ||
        download.size > 32 * 1024 * 1024 ||
        total + download.size > 128 * 1024 * 1024
      )
        throw new Error("Remote context byte budget exceeded");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of download.chunks) {
        signal.throwIfAborted();
        size += chunk.length;
        if (size > 32 * 1024 * 1024) throw new Error("File exceeds context budget");
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      options.retain?.(sha256);
      const begun = await context.uploads.handle(owner, {
        op: "upload.begin",
        threadId: threadId,
        sha256,
        bytes: bytes.length,
        name: basename(path),
      });
      if (begun.kind !== "upload") throw new Error("Source upload unavailable");
      try {
        for (let offset = begun.offset; offset < bytes.length; offset += 65536) {
          signal.throwIfAborted();
          await context.uploads.handle(owner, {
            op: "upload.chunk",
            uploadId: begun.uploadId,
            offset,
            data: bytes.subarray(offset, offset + 65536).toString("base64"),
          });
        }
        const committed = await context.uploads.handle(owner, {
          op: "upload.commit",
          uploadId: begun.uploadId,
        });
        if (committed.kind !== "attachment") throw new Error("Source attachment unavailable");
        add({ ...committed.attachment, sourcePath: path });
      } catch (error) {
        await context.uploads
          .handle(owner, { op: "upload.cancel", uploadId: begun.uploadId })
          .catch(() => {});
        throw error;
      }
    } finally {
      await download.close();
    }
  }
  return attachments;
}
