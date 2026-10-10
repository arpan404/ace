import { AttachmentBytes } from "./attachment-bytes.ts";
import { attachmentDownload } from "./attachment-download.ts";
import { prepareFiles } from "./prepare-files.ts";
import { join } from "node:path";
import {
  ContextRequest,
  type Attachment,
  MessageContext,
  type ContextResult,
  type ContextDiagnostic,
  type ThreadRefContextItem,
  ResolvedThreadReference,
} from "@ace/protocol";
import { ContextError, requireContext } from "./errors.ts";
import { resolveMentions } from "./mentions.ts";
import { WorkspaceCache } from "./workspace-cache.ts";
import { UploadStore, type UploadOptions } from "./upload-store.ts";
import {
  projectAttachments,
  ProjectionCapabilities,
  type PreparedAttachment,
  type Projection,
} from "./projection.ts";

export interface ContextServiceOptions extends UploadOptions {
  /** Decoder I/O boundary; production defaults to the bounded Sharp renderer. */
  renderThumbnail?(path: string): Promise<Buffer>;
  /** Logical project root used to authorize draft adoption into isolated worktrees. */
  threadWorkspaceRoot?(id: string): string | undefined | Promise<string | undefined>;
  workspaceRoot?(id: string): string | undefined | Promise<string | undefined>;
  threadReference?(
    device: string,
    owner: string,
    reference: ThreadRefContextItem,
  ): Promise<ResolvedThreadReference>;
  /** Lookup captured native-image metadata only; a client reference never authorizes file IO. */
  imageReference?(thread: string, reference: string, itemId?: string): Attachment | undefined;
  workspace(thread: string): string | undefined | Promise<string | undefined>;
}
export class ContextService {
  readonly uploads: UploadStore;
  private attachmentBytes: AttachmentBytes;
  private workspaces = new WorkspaceCache();
  private options: ContextServiceOptions;
  private constructor(options: ContextServiceOptions, uploads: UploadStore) {
    this.options = options;
    this.attachmentBytes = new AttachmentBytes(options.renderThumbnail);
    this.uploads = uploads;
  }
  static async open(options: ContextServiceOptions): Promise<ContextService> {
    return new ContextService(
      options,
      await UploadStore.open({
        ...options,
        ...(options.workspaceRoot ? { workspace: options.workspaceRoot } : {}),
        threadWorkspace: options.threadWorkspaceRoot ?? options.workspace,
      }),
    );
  }
  private async workspace(device: string, thread: string) {
    requireContext(
      await this.options.authorize(device, thread),
      "forbidden",
      "Thread access denied",
    );
    const root = await this.options.workspace(thread);
    requireContext(root, "not_found", "Thread workspace unavailable");
    return this.workspaces.get(root);
  }
  draftWorkspace(device: string, draftId: string): Promise<string> {
    return this.uploads.draftWorkspace(device, draftId);
  }
  async handle(
    device: string,
    value: unknown,
    access: (thread?: string) => boolean = () => true,
  ): Promise<ContextResult> {
    const request = ContextRequest.parse(value);
    try {
      requireContext(access(), "forbidden", "Device access revoked");
      const op = request.operation;
      let result: ContextResult["result"];
      if (op.op === "image.resolve") {
        requireContext(
          access(op.threadId) && (await this.options.authorize(device, op.threadId)),
          "forbidden",
          "Thread access denied",
        );
        const attachment = this.options.imageReference?.(op.threadId, op.reference, op.itemId);
        requireContext(
          attachment,
          "not_found",
          "Image has not been saved from this thread's environment",
        );
        result = { kind: "attachment", attachment };
      } else if (op.op === "attachment.read") {
        const read = await this.readAttachment(
          device,
          op.threadId,
          op.sha256,
          op.variant,
          op.offset,
          op.limit,
          access,
        );
        result = {
          kind: "attachment.data",
          sha256: op.sha256,
          variant: op.variant,
          mimeType: read.mimeType,
          bytes: read.bytes,
          offset: op.offset,
          data: read.data.toString("base64"),
          eof: op.offset + read.data.length === read.bytes,
        };
      } else if (op.op === "draft.mention.complete")
        result = {
          kind: "completion",
          paths: (
            await this.workspaces.get(await this.uploads.draftWorkspace(device, op.draftId))
          ).index.complete(op.query, op.limit),
        };
      else if (op.op === "mention.resolve")
        result = {
          kind: "mentions",
          ...(await resolveMentions(await this.workspace(device, op.threadId), op.mentions)),
        };
      else if (op.op === "mention.complete")
        result = {
          kind: "completion",
          paths: (await this.workspace(device, op.threadId)).index.complete(op.query, op.limit),
        };
      else result = await this.uploads.handle(device, op, access);
      return { type: "context.result", requestId: request.requestId, result };
    } catch (error) {
      return {
        type: "context.result",
        requestId: request.requestId,
        result: {
          kind: "error",
          code: error instanceof ContextError ? error.code : "invalid_request",
          message: error instanceof ContextError ? error.message : "Context operation failed",
        },
      };
    }
  }
  async resolveThreadReferences(
    device: string,
    thread: string,
    value: MessageContext,
  ): Promise<ResolvedThreadReference[]> {
    const context = MessageContext.parse(value);
    requireContext(
      await this.options.authorize(device, thread),
      "forbidden",
      "Thread access denied",
    );
    const references = context.items ?? [];
    requireContext(
      references.reduce((sum, item) => sum + item.budgetBytes, 0) <= 32768,
      "quota",
      "Thread context budget exceeded",
    );
    if (!references.length) return [];
    const resolve = this.options.threadReference;
    requireContext(resolve, "unsupported", "Thread reference service unavailable");
    const results: ResolvedThreadReference[] = [];
    for (const reference of references) {
      const result = ResolvedThreadReference.parse(await resolve(device, thread, reference));
      requireContext(
        result.threadId === reference.threadId && result.pointer.threadId === reference.threadId,
        "forbidden",
        "Thread reference scope mismatch",
      );
      requireContext(
        Buffer.byteLength(result.summary) + Buffer.byteLength(JSON.stringify(result.pointer)) <=
          reference.budgetBytes,
        "quota",
        "Thread reference exceeds its byte budget",
      );
      results.push(result);
    }
    return results;
  }
  /** Engine hook: resolve thread-owned references before calling the adapter. No client paths accepted. */
  async compose(
    device: string,
    thread: string,
    value: MessageContext,
    settings: ProjectionCapabilities,
  ): Promise<{
    projection: Projection;
    attachments: import("@ace/protocol").Attachment[];
    attachmentPaths: { sha256: string; path: string }[];
    diagnostics: ContextDiagnostic[];
    release(): void;
  }> {
    const context = MessageContext.parse(value);
    const capabilities = ProjectionCapabilities.parse(settings);
    requireContext(
      await this.options.authorize(device, thread),
      "forbidden",
      "Thread access denied",
    );
    if (context.draftId) await this.uploads.adopt(device, context.draftId, thread);
    const lease = await this.uploads.acquireMessage(
      device,
      thread,
      context.attachments.map((reference) => reference.sha256),
    );
    try {
      const workspace = context.mentions.length ? await this.workspace(device, thread) : undefined;
      const mentions = workspace
        ? await resolveMentions(workspace, context.mentions)
        : { entries: [], diagnostics: [] };
      const references = await this.resolveThreadReferences(device, thread, context);
      const prepared: PreparedAttachment[] = mentions.entries.map((entry) => ({
        path: join(workspace?.root ?? "", entry.path),
        name: entry.path,
        mimeType: "text/plain",
        text: entry.text,
      }));
      for (const reference of references)
        prepared.push({
          path: `ace://thread/${reference.threadId}`,
          name: reference.threadId,
          mimeType: "text/plain",
          text: `${reference.summary}\nPointer: ${JSON.stringify(reference.pointer)}`,
        });
      prepared.push(...(await prepareFiles(lease.blobs, capabilities)));
      // Binary mentions still carry a usable, validated workspace path.
      for (const diagnostic of mentions.diagnostics) {
        if (diagnostic.code === "binary" && diagnostic.path)
          prepared.push({
            path: join(workspace?.root ?? "", diagnostic.path),
            name: diagnostic.path,
            mimeType: "application/octet-stream",
          });
      }
      const projection = projectAttachments(prepared, capabilities);
      return {
        projection,
        attachmentPaths: lease.blobs.map((blob, index) => ({
          sha256: blob.attachment.sha256,
          path: prepared[mentions.entries.length + references.length + index]?.path ?? blob.path,
        })),
        attachments: lease.blobs.map((blob, index) => {
          const part = projection.input[mentions.entries.length + references.length + index];
          const file = prepared[mentions.entries.length + references.length + index];
          const delivery: import("@ace/protocol").Attachment["delivery"] =
            part?.type === "text"
              ? file?.text === undefined
                ? "file_path"
                : file.truncated
                  ? "inline_text_and_path"
                  : "inline_text"
              : part?.type === "document"
                ? "native_pdf"
                : part?.type === "resource"
                  ? "native_resource"
                  : part?.type === "file" && part.mime === "application/pdf"
                    ? "native_pdf"
                    : "native_image";
          return { ...blob.attachment, delivery };
        }),
        diagnostics: [...mentions.diagnostics, ...projection.diagnostics],
        release: lease.release,
      };
    } catch (error) {
      lease.release();
      throw error;
    }
  }
  async readAttachment(
    device: string,
    thread: string,
    hash: string,
    variant: "original" | "thumbnail",
    offset: number,
    limit: number,
    access: () => boolean = () => true,
  ) {
    requireContext(access(), "forbidden", "Thread read permission required");
    const lease = await this.uploads.acquire(device, thread, [hash]);
    try {
      const blob = lease.blobs[0];
      requireContext(blob, "not_found", "Attachment unavailable");
      const result = await this.attachmentBytes.read(blob, variant, offset, limit);
      requireContext(access(), "forbidden", "Thread read permission revoked");
      return result;
    } finally {
      lease.release();
    }
  }
  async downloadAttachment(
    device: string,
    thread: string,
    hash: string,
    maxBytes: number,
    access: () => boolean,
  ) {
    requireContext(access(), "forbidden", "Thread read permission required");
    return attachmentDownload(await this.uploads.acquire(device, thread, [hash]), maxBytes, access);
  }
  async close(): Promise<void> {
    await this.workspaces.close();
    await this.uploads.close();
  }
}
