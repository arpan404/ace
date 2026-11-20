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
import { resolveMentions, resolveWorkspaceMentions } from "./mentions.ts";
import { prepareWorkspaceBinary } from "./workspace-binary.ts";
import { GitWorkspace, type WorkspaceFileEntry, type WorkspaceFiles } from "./git-workspace.ts";
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
  /**
   * The words of Spade bots' replies a `bot_replies` item names (ADR 0194), framed untrusted by
   * the daemon; undefined when none of them is this thread's.
   */
  botReplies?(thread: string, keys: readonly string[]): string | undefined;
  /** Lookup captured native-image metadata only; a client reference never authorizes file IO. */
  imageReference?(thread: string, reference: string, itemId?: string): Attachment | undefined;
  workspace(thread: string): string | undefined | Promise<string | undefined>;
  /**
   * Quick open over a checkout, answered by ace-files (`indexQuery`). `ready` is false while the
   * index is still building. Without this hook the reply is `unsupported`.
   */
  complete?(
    root: string,
    query: string,
    limit: number,
  ): Promise<{ paths: readonly string[]; ready: boolean }>;
  /** A folder mention's files, answered by ace-files' paged listing. */
  listFolder?(root: string, folder: string): AsyncIterable<WorkspaceFileEntry>;
}
export class ContextService {
  readonly uploads: UploadStore;
  private attachmentBytes: AttachmentBytes;
  private readers = new Map<string, WorkspaceFiles>();
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
  private async workspaceRoot(device: string, thread: string): Promise<string> {
    requireContext(
      await this.options.authorize(device, thread),
      "forbidden",
      "Thread access denied",
    );
    const root = await this.options.workspace(thread);
    requireContext(root, "not_found", "Thread workspace unavailable");
    return root;
  }
  /** One checkout's mention reader, made once per root; it holds no index and no watcher. */
  private reader(root: string): WorkspaceFiles {
    const known = this.readers.get(root);
    if (known) return known;
    const listFolder = this.options.listFolder;
    const reader = new GitWorkspace(
      root,
      {},
      listFolder === undefined ? {} : { list: (folder) => listFolder(root, folder) },
    );
    this.readers.set(root, reader);
    return reader;
  }
  /**
   * Quick open through ace-files. Access is asked again after the index answers, because a
   * socket can close, a device lose its grant or a thread stop being readable while it builds.
   */
  private async completion(
    root: string,
    query: string,
    limit: number,
    access: () => boolean,
  ): Promise<Extract<ContextResult["result"], { kind: "completion" }>> {
    const complete = this.options.complete;
    requireContext(complete, "unsupported", "File search unavailable");
    let answer: { paths: readonly string[]; ready: boolean };
    try {
      answer = await complete(root, query, limit);
    } catch (error) {
      if (error instanceof ContextError) throw error;
      throw new ContextError("busy", error instanceof Error ? error.message : "File search failed");
    }
    requireContext(access(), "forbidden", "Device access revoked");
    return {
      kind: "completion",
      paths: answer.paths.slice(0, 50),
      ready: answer.ready,
    };
  }
  draftWorkspace(device: string, draftId: string): Promise<string> {
    return this.uploads.draftWorkspace(device, draftId);
  }
  /** Engine hook: a continued thread's first message may carry files its source holds. */
  inheritAttachments(
    device: string,
    source: string,
    thread: string,
    hashes: readonly string[],
  ): Promise<void> {
    return this.uploads.inherit(device, source, thread, hashes);
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
        result = await this.completion(
          await this.uploads.resumableDraftWorkspace(device, op.draftId),
          op.query,
          op.limit,
          access,
        );
      else if (op.op === "mention.resolve")
        result = {
          kind: "mentions",
          ...(await resolveMentions(
            this.reader(await this.workspaceRoot(device, op.threadId)),
            op.mentions,
          )),
        };
      else if (op.op === "mention.complete")
        result = await this.completion(
          await this.workspaceRoot(device, op.threadId),
          op.query,
          op.limit,
          () => access(op.threadId),
        );
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
    // Browser tabs are the daemon's to expand when the message is delivered, not context's.
    const references = (context.items ?? []).filter((item) => item.type === "thread_ref");
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
    /** Per message attachment, in order: its part in `projection.input` and its name. */
    files: { part: number; name: string }[];
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
      let root = "";
      let mentions: Awaited<ReturnType<typeof resolveWorkspaceMentions>> = {
        entries: [],
        diagnostics: [],
      };
      if (context.mentions.length) {
        const workspace = this.reader(await this.workspaceRoot(device, thread));
        root = workspace.root;
        mentions = await resolveWorkspaceMentions(workspace, context.mentions);
      }
      const references = await this.resolveThreadReferences(device, thread, context);
      const prepared: PreparedAttachment[] = mentions.entries.map((entry) => ({
        path: join(root, entry.path),
        name: entry.path,
        mimeType: "text/plain",
        text: entry.text,
        ...(entry.scope === "file" && !entry.truncated ? { workspaceFile: true } : {}),
      }));
      for (const reference of references)
        prepared.push({
          path: `ace://thread/${reference.threadId}`,
          name: reference.threadId,
          mimeType: "text/plain",
          text: `${reference.summary}\nPointer: ${JSON.stringify(reference.pointer)}`,
        });
      // Bots' replies the agent hasn't heard ride with the person's next message, untrusted.
      for (const item of context.items ?? []) {
        if (item.type !== "bot_replies") continue;
        const text = this.options.botReplies?.(thread, item.keys);
        if (text)
          prepared.push({
            path: `ace://thread/${thread}/bot-replies`,
            name: "Spade bots' replies",
            mimeType: "text/plain",
            text,
          });
      }
      prepared.push(...(await prepareFiles(lease.blobs, capabilities)));
      // Binary mentions take the attached-file route: images and PDFs reach providers natively.
      const budget = {
        remaining:
          capabilities.maxInlineBytes -
          prepared.reduce((sum, item) => sum + Math.ceil(((item.base64?.length ?? 0) * 3) / 4), 0),
      };
      const binaries = new Map<number, ContextDiagnostic>();
      for (const diagnostic of mentions.diagnostics) {
        const path = diagnostic.path;
        if (diagnostic.code !== "binary" || !path || !root) continue;
        binaries.set(prepared.length, diagnostic);
        prepared.push(
          // One reader holds the root, so a binary mention reads the file the mention named.
          await prepareWorkspaceBinary(this.reader(root), path, capabilities, budget).catch(() => ({
            path: join(root, path),
            name: path,
            mimeType: "application/octet-stream",
          })),
        );
      }
      const projection = projectAttachments(prepared, capabilities);
      // A binary delivered in native form is no longer "omitted".
      const delivered = new Set(
        [...binaries]
          .filter(([index]) => projection.input[index]?.type !== "text")
          .map(([, d]) => d),
      );
      return {
        projection,
        attachmentPaths: lease.blobs.map((blob, index) => ({
          sha256: blob.attachment.sha256,
          path: prepared[mentions.entries.length + references.length + index]?.path ?? blob.path,
        })),
        files: lease.blobs.map((blob, index) => ({
          part: mentions.entries.length + references.length + index,
          name: blob.attachment.name,
        })),
        attachments: lease.blobs.map((blob, index) => ({
          ...blob.attachment,
          delivery: projection.deliveries[mentions.entries.length + references.length + index],
        })),
        diagnostics: [
          ...mentions.diagnostics.filter((diagnostic) => !delivered.has(diagnostic)),
          ...projection.diagnostics,
        ],
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
    this.readers.clear();
    await this.uploads.close();
  }
}
