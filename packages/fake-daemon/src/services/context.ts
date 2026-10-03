import type { Attachment, ContextOperation, ContextResult } from "@ace/protocol";
import { completePaths } from "./workspace-files.ts";

type Result = ContextResult["result"];

interface Upload {
  threadId: string;
  sha256: string;
  name: string;
  bytes: number;
  offset: number;
}

const mimeTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  md: "text/markdown",
  txt: "text/plain",
  json: "application/json",
};

/** Bytes a base64 chunk carries, without decoding it. */
function decodedLength(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

/**
 * `context.request` in memory: mention completion over each project's checkout and the resumable
 * upload sequence (begin, chunk at the acknowledged offset, commit) that yields an attachment.
 */
export class FakeContext {
  private uploads = new Map<string, Upload>();
  private attachments = new Map<string, Attachment[]>();
  private next = 0;
  private workspaceOf: (threadId: string) => string | undefined;
  constructor(workspaceOf: (threadId: string) => string | undefined) {
    this.workspaceOf = workspaceOf;
  }
  handle(operation: ContextOperation): Result {
    switch (operation.op) {
      case "mention.complete": {
        const workspace = this.workspaceOf(operation.threadId);
        if (workspace === undefined)
          return { kind: "error", code: "not_found", message: "No such thread" };
        return {
          kind: "completion",
          paths: completePaths(workspace, operation.query, operation.limit),
        };
      }
      case "upload.begin": {
        if (this.workspaceOf(operation.threadId) === undefined)
          return { kind: "error", code: "not_found", message: "No such thread" };
        const uploadId = `upload-${++this.next}`;
        this.uploads.set(uploadId, { ...operation, offset: 0 });
        return { kind: "upload", uploadId, offset: 0, bytes: operation.bytes };
      }
      case "upload.status":
      case "upload.chunk": {
        const upload = this.uploads.get(operation.uploadId);
        if (!upload) return { kind: "error", code: "not_found", message: "No such upload" };
        if (operation.op === "upload.chunk") {
          if (operation.offset !== upload.offset)
            return { kind: "error", code: "offset", message: "Resume at the acknowledged offset" };
          upload.offset = Math.min(upload.bytes, upload.offset + decodedLength(operation.data));
        }
        return {
          kind: "upload",
          uploadId: operation.uploadId,
          offset: upload.offset,
          bytes: upload.bytes,
        };
      }
      case "upload.commit": {
        const upload = this.uploads.get(operation.uploadId);
        if (!upload) return { kind: "error", code: "not_found", message: "No such upload" };
        if (upload.offset !== upload.bytes)
          return { kind: "error", code: "offset", message: "Upload is incomplete" };
        this.uploads.delete(operation.uploadId);
        const extension = upload.name.split(".").at(-1)?.toLowerCase() ?? "";
        const attachment: Attachment = {
          sha256: upload.sha256,
          bytes: upload.bytes,
          mimeType: mimeTypes[extension] ?? "application/octet-stream",
          name: upload.name,
        };
        this.attachments.set(upload.threadId, [
          ...(this.attachments.get(upload.threadId) ?? []),
          attachment,
        ]);
        return { kind: "attachment", attachment };
      }
      case "upload.cancel":
        this.uploads.delete(operation.uploadId);
        return { kind: "ok" };
      case "attachment.list":
        return { kind: "attachments", attachments: this.attachments.get(operation.threadId) ?? [] };
      case "attachment.release":
        this.attachments.set(
          operation.threadId,
          (this.attachments.get(operation.threadId) ?? []).filter(
            (attachment) => attachment.sha256 !== operation.sha256,
          ),
        );
        return { kind: "ok" };
      case "mention.resolve":
        return { kind: "error", code: "unsupported", message: "Not served by the fake daemon" };
    }
  }
}
