import { open } from "node:fs/promises";
import { join } from "node:path";
import {
  ContextRequest,
  MessageContext,
  type ContextResult,
  type ContextDiagnostic,
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
  workspace(thread: string): string | undefined | Promise<string | undefined>;
}
export class ContextService {
  readonly uploads: UploadStore;
  private workspaces = new WorkspaceCache();
  private options: ContextServiceOptions;
  private constructor(options: ContextServiceOptions, uploads: UploadStore) {
    this.options = options;
    this.uploads = uploads;
  }
  static async open(options: ContextServiceOptions): Promise<ContextService> {
    return new ContextService(options, await UploadStore.open(options));
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
  async handle(
    device: string,
    value: unknown,
    access: () => boolean = () => true,
  ): Promise<ContextResult> {
    const request = ContextRequest.parse(value);
    try {
      requireContext(access(), "forbidden", "Device access revoked");
      const op = request.operation;
      let result: ContextResult["result"];
      if (op.op === "mention.resolve")
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
  /** Engine hook: resolve thread-owned references before calling the adapter. No client paths accepted. */
  async compose(
    device: string,
    thread: string,
    value: MessageContext,
    settings: ProjectionCapabilities,
  ): Promise<{ projection: Projection; diagnostics: ContextDiagnostic[]; release(): void }> {
    const context = MessageContext.parse(value);
    const capabilities = ProjectionCapabilities.parse(settings);
    requireContext(
      await this.options.authorize(device, thread),
      "forbidden",
      "Thread access denied",
    );
    const lease = await this.uploads.acquire(
      device,
      thread,
      context.attachments.map((reference) => reference.sha256),
    );
    try {
      const workspace = context.mentions.length ? await this.workspace(device, thread) : undefined;
      const mentions = workspace
        ? await resolveMentions(workspace, context.mentions)
        : { entries: [], diagnostics: [] };
      const prepared: PreparedAttachment[] = mentions.entries.map((entry) => ({
        path: join(workspace?.root ?? "", entry.path),
        name: entry.path,
        mimeType: "text/plain",
        text: entry.text,
      }));
      let remaining = capabilities.maxInlineBytes;
      for (const blob of lease.blobs) {
        const attachment: PreparedAttachment = {
          path: blob.path,
          name: blob.attachment.name,
          mimeType: blob.attachment.mimeType,
        };
        const needsInline = capabilities.provider === "claude" || capabilities.provider === "acp";
        if (
          needsInline &&
          blob.attachment.bytes <= remaining &&
          (capabilities.images.includes(attachment.mimeType) ||
            capabilities.documents.includes(attachment.mimeType))
        ) {
          remaining -= blob.attachment.bytes;
          const file = await open(blob.path, "r");
          try {
            const bytes = Buffer.alloc(blob.attachment.bytes);
            let offset = 0;
            while (offset < bytes.length) {
              const read = await file.read(bytes, offset, bytes.length - offset, offset);
              requireContext(read.bytesRead > 0, "not_found", "Attachment bytes unavailable");
              offset += read.bytesRead;
            }
            attachment.base64 = bytes.toString("base64");
          } finally {
            await file.close();
          }
        }
        prepared.push(attachment);
      }
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
        diagnostics: [...mentions.diagnostics, ...projection.diagnostics],
        release: lease.release,
      };
    } catch (error) {
      lease.release();
      throw error;
    }
  }
  async close(): Promise<void> {
    await this.workspaces.close();
    await this.uploads.close();
  }
}
