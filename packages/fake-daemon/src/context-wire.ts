import { imageSize } from "image-size";
import { fixtureImage } from "./attachment-fixture.ts";
import {
  ContextErrorCode,
  ContextResult,
  type ContextRequest,
  type Attachment,
} from "@ace/protocol";
import type { FakeServiceContext } from "./service-context.ts";
import { completePaths } from "./services/workspace-files.ts";

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
function mimeType(name: string): string {
  return mimeTypes[name.split(".").at(-1)?.toLowerCase() ?? ""] ?? "application/octet-stream";
}
interface Upload {
  device: string;
  scope: string;
  hash: string;
  size: number;
  name: string;
  chunks: Uint8Array[];
  offset: number;
  attachment?: Attachment;
}
export class FakeContextWire {
  private context: FakeServiceContext;
  private checkoutPaths: ((threadId: string) => string[]) | undefined;
  private drafts = new Map<string, { device: string; workspaceId: string; adopted?: string }>();
  private uploads = new Map<string, Upload>();
  private attachments = new Map<string, Map<string, Attachment>>();
  seedImage(threadId: string, name = fixtureImage.name): void {
    if (!this.context.thread(threadId)) return;
    const bytes = Uint8Array.from(atob(fixtureImage.data), (c) => c.charCodeAt(0));
    this.blobs.set(fixtureImage.sha256, bytes);
    this.references(threadId).set(fixtureImage.sha256, {
      sha256: fixtureImage.sha256,
      bytes: bytes.length,
      name,
      ...imageMetadata(bytes, name),
    });
  }
  private counter = 0;
  private blobs = new Map<string, Uint8Array>();
  messageAttachments(thread: string, hashes: readonly string[]): Attachment[] {
    return hashes.map((hash) => {
      const attachment = this.references(thread).get(hash);
      if (!attachment) throw new Error("not_found");
      return attachment;
    });
  }
  constructor(context: FakeServiceContext, checkoutPaths?: (threadId: string) => string[]) {
    this.checkoutPaths = checkoutPaths;
    this.context = context;
  }
  private references(scope: string) {
    let map = this.attachments.get(scope);
    if (!map) {
      if (this.attachments.size >= 256) throw new Error("quota");
      map = new Map();
      this.attachments.set(scope, map);
    }
    return map;
  }
  adopt(device: string, draftId: string, threadId: string): void {
    const draft = this.drafts.get(draftId);
    const thread = this.context.thread(threadId)?.thread;
    if (
      !draft ||
      draft.device !== device ||
      draft.workspaceId !== thread?.workspaceId ||
      (draft.adopted && draft.adopted !== threadId)
    )
      throw new Error("forbidden");
    this.validateDraft(device, draftId, draft.workspaceId, threadId);
    const target = this.references(threadId);
    const source = this.references(draftId);
    if (target.size + source.size > 256) throw new Error("quota");
    for (const [key, attachment] of source) target.set(key, attachment);
    source.clear();
    draft.adopted = threadId;
    for (const upload of this.uploads.values())
      if (upload.scope === draftId) upload.scope = threadId;
  }
  draftWorkspace(device: string, draftId: string): string {
    const draft = this.drafts.get(draftId);
    if (!draft || draft.device !== device) throw new Error("draft_unavailable");
    return draft.workspaceId;
  }
  validateDraft(device: string, draftId: string, workspaceId: string, threadId?: string): void {
    const draft = this.drafts.get(draftId);
    if (
      !draft ||
      draft.device !== device ||
      draft.workspaceId !== workspaceId ||
      (draft.adopted && draft.adopted !== threadId)
    )
      throw new Error("forbidden");
    for (const upload of this.uploads.values())
      if (upload.scope === draftId && !upload.attachment) throw new Error("busy");
  }
  async handle(request: ContextRequest, device: string) {
    const op = request.operation;
    let result: ContextResult["result"];
    const check = (scope: string) => {
      const draft = this.drafts.get(scope);
      if (draft ? draft.device !== device : !this.context.thread(scope))
        throw new Error("forbidden");
    };
    try {
      if (op.op === "draft.create") {
        if (this.drafts.size >= 64) throw new Error("quota");
        const draftId = `draft-${++this.counter}`;
        this.drafts.set(draftId, { device, workspaceId: op.workspaceId });
        result = { kind: "draft", draftId };
      } else if (op.op === "draft.release") {
        check(op.draftId);
        this.drafts.delete(op.draftId);
        this.attachments.delete(op.draftId);
        for (const [id, upload] of this.uploads)
          if (upload.scope === op.draftId) this.uploads.delete(id);
        result = { kind: "ok" };
      } else if (op.op === "upload.begin" || op.op === "draft.upload.begin") {
        const scope = "threadId" in op ? op.threadId : op.draftId;
        check(scope);
        if (this.uploads.size >= 64) {
          for (const [id, upload] of this.uploads)
            if (upload.attachment) {
              this.uploads.delete(id);
              break;
            }
        }
        if (this.uploads.size >= 64 || op.bytes > 1_048_576) throw new Error("quota");
        const uploadId = `upload-${++this.counter}`;
        this.uploads.set(uploadId, {
          device,
          scope,
          hash: op.sha256,
          size: op.bytes,
          name: op.name,
          chunks: [],
          offset: 0,
        });
        result = { kind: "upload", uploadId, offset: 0, bytes: op.bytes };
      } else if ("uploadId" in op) {
        const upload = this.uploads.get(op.uploadId);
        if (!upload || upload.device !== device) throw new Error("not_found");
        check(upload.scope);
        if (op.op === "upload.cancel") {
          this.uploads.delete(op.uploadId);
          result = { kind: "ok" };
        } else if (op.op === "upload.commit") {
          if (upload.attachment)
            return ContextResult.parse({
              type: "context.result",
              requestId: request.requestId,
              result: { kind: "attachment", attachment: upload.attachment },
            });
          if (upload.offset !== upload.size) throw new Error("offset");
          const bytes = new Uint8Array(upload.size);
          let offset = 0;
          for (const chunk of upload.chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
          if (hash !== upload.hash) throw new Error("hash_mismatch");
          const refs = this.references(upload.scope);
          if (refs.size >= 256 && !refs.has(hash)) throw new Error("quota");
          const attachment = {
            sha256: hash,
            bytes: bytes.length,
            ...imageMetadata(bytes, upload.name),
            name: upload.name,
          };
          if (!this.blobs.has(hash) && this.blobs.size >= 256) throw new Error("quota");
          this.blobs.set(hash, bytes);
          refs.set(hash, attachment);
          upload.attachment = attachment;
          upload.chunks = [];
          result = { kind: "attachment", attachment };
        } else {
          if (op.op === "upload.chunk") {
            if (upload.attachment) throw new Error("busy");
            if (op.offset !== upload.offset) throw new Error("offset");
            const bytes = Uint8Array.from(atob(op.data), (char) => char.charCodeAt(0));
            if (bytes.length > 65536 || bytes.length + upload.offset > upload.size)
              throw new Error("offset");
            upload.chunks.push(bytes);
            upload.offset += bytes.length;
          }
          result = {
            kind: "upload",
            uploadId: op.uploadId,
            offset: upload.offset,
            bytes: upload.size,
          };
        }
      } else if (op.op === "attachment.read") {
        check(op.threadId);
        const attachment = this.references(op.threadId).get(op.sha256),
          bytes = this.blobs.get(op.sha256);
        if (!attachment || !bytes) throw new Error("not_found");
        if (op.variant === "thumbnail" && !attachment.thumbnailAvailable)
          throw new Error("unsupported");
        if (op.offset > bytes.length) throw new Error("offset");
        const chunk = bytes.subarray(op.offset, op.offset + op.limit);
        result = {
          kind: "attachment.data",
          sha256: op.sha256,
          variant: op.variant,
          mimeType: attachment.mimeType,
          bytes: bytes.length,
          offset: op.offset,
          data: btoa(String.fromCharCode(...chunk)),
          eof: op.offset + chunk.length === bytes.length,
        };
      } else if (op.op === "attachment.list") {
        check(op.threadId);
        result = { kind: "attachments", attachments: [...this.references(op.threadId).values()] };
      } else if (op.op === "attachment.release" || op.op === "draft.attachment.release") {
        const scope = "threadId" in op ? op.threadId : op.draftId;
        check(scope);
        this.references(scope).delete(op.sha256);
        if (![...this.attachments.values()].some((refs) => refs.has(op.sha256)))
          this.blobs.delete(op.sha256);
        result = { kind: "ok" };
      } else if (op.op === "image.resolve") {
        check(op.threadId);
        const view = this.context.thread(op.threadId);
        const boundary = op.itemId
          ? (view?.itemOrder.indexOf(op.itemId) ?? -1)
          : (view?.itemOrder.length ?? 0);
        const found = view?.itemOrder
          .slice(0, Math.max(0, boundary))
          .toReversed()
          .map((id) => view.items[id])
          .find(
            (item) =>
              item?.type === "tool_call" &&
              (!op.itemId ||
                op.reference.startsWith("/") ||
                item.agentId === view?.items[op.itemId]?.agentId) &&
              item.call.detail.kind === "image" &&
              (item.call.detail.path === op.reference ||
                item.call.detail.sourcePath === op.reference),
          );
        result =
          found?.type === "tool_call" &&
          found.call.detail.kind === "image" &&
          found.call.detail.attachment
            ? { kind: "attachment", attachment: found.call.detail.attachment }
            : { kind: "error", code: "not_found", message: "Image not saved" };
      } else if (op.op === "mention.resolve") {
        check(op.threadId);
        result = {
          kind: "mentions",
          entries: [],
          diagnostics: op.mentions.map((mention) => ({
            code: "not_found",
            path: mention.path,
            message: "Seed a file fixture to resolve this mention",
          })),
        };
      } else {
        const scope = "draftId" in op ? op.draftId : op.threadId;
        check(scope);
        const workspaceId =
          this.drafts.get(scope)?.workspaceId ?? this.context.thread(scope)?.thread.workspaceId;
        result = {
          kind: "completion",
          paths: workspaceId
            ? completePaths(
                workspaceId,
                op.query,
                op.limit,
                this.drafts.has(scope) ? undefined : this.checkoutPaths?.(scope),
              )
            : [],
        };
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : "invalid_request";
      result = {
        kind: "error",
        code: [
          "quota",
          "busy",
          "offset",
          "hash_mismatch",
          "not_found",
          "forbidden",
          "unsupported",
        ].includes(code)
          ? ContextErrorCode.parse(code)
          : "invalid_request",
        message: code,
      };
    }
    return ContextResult.parse({ type: "context.result", requestId: request.requestId, result });
  }
}

/** Fixture previews reuse small originals. Production generates bounded PNG previews. */
function imageMetadata(
  bytes: Uint8Array,
  name: string,
): { mimeType: string; width?: number; height?: number; thumbnailAvailable: boolean } {
  const png =
    bytes.length >= 24 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
  const gif = bytes.length >= 10 && String.fromCharCode(...bytes.subarray(0, 3)) === "GIF";
  const webp = bytes.length >= 12 && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP";
  const mime = gif
    ? "image/gif"
    : webp
      ? "image/webp"
      : png
        ? "image/png"
        : bytes[0] === 255 && bytes[1] === 216
          ? "image/jpeg"
          : mimeType(name);
  let dimensions: { width: number; height: number } | undefined;
  if (mime.startsWith("image/")) {
    try {
      const size = imageSize(bytes);
      dimensions = { width: size.width, height: size.height };
    } catch {
      /* Opaque fixture data has no thumbnail. */
    }
  }
  return {
    mimeType: mime,
    thumbnailAvailable: dimensions !== undefined && bytes.length <= 256 * 1024,
    ...dimensions,
  };
}
