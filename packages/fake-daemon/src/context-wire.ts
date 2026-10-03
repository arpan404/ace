import { ContextErrorCode, ContextResult, type ContextRequest } from "@ace/protocol";
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
  attachment?: { sha256: string; bytes: number; mimeType: string; name: string };
}
export class FakeContextWire {
  private context: FakeServiceContext;
  private drafts = new Map<string, { device: string; workspaceId: string; adopted?: string }>();
  private uploads = new Map<string, Upload>();
  private attachments = new Map<
    string,
    Map<string, { sha256: string; bytes: number; mimeType: string; name: string }>
  >();
  private counter = 0;
  constructor(context: FakeServiceContext) {
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
    if (target.size + source.size > 64) throw new Error("quota");
    for (const [key, attachment] of source) target.set(key, attachment);
    source.clear();
    draft.adopted = threadId;
    for (const upload of this.uploads.values())
      if (upload.scope === draftId) upload.scope = threadId;
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
          if (refs.size >= 64) throw new Error("quota");
          const attachment = {
            sha256: hash,
            bytes: bytes.length,
            mimeType: mimeType(upload.name),
            name: upload.name,
          };
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
      } else if (op.op === "attachment.list") {
        check(op.threadId);
        result = { kind: "attachments", attachments: [...this.references(op.threadId).values()] };
      } else if (op.op === "attachment.release") {
        check(op.threadId);
        this.references(op.threadId).delete(op.sha256);
        result = { kind: "ok" };
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
          paths: workspaceId ? completePaths(workspaceId, op.query, op.limit) : [],
        };
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : "invalid_request";
      result = {
        kind: "error",
        code: ["quota", "busy", "offset", "hash_mismatch", "not_found", "forbidden"].includes(code)
          ? ContextErrorCode.parse(code)
          : "invalid_request",
        message: code,
      };
    }
    return ContextResult.parse({ type: "context.result", requestId: request.requestId, result });
  }
}
