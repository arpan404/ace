import type { ClientCore } from "@ace/client";
import type {
  Attachment,
  ContextOperation,
  ContextResult,
  MessageContext,
  ThreadId,
} from "@ace/protocol";
import { ContextError, attachmentLimits, attachmentSizeProblem, expectContext } from "@ace/ui-core";
import { z } from "zod";
import { call } from "./host.ts";
import { preview } from "./presentation.ts";

/*
 * Files and photos for a message: the open thread's next one, or New thread's first. Swift keeps
 * the picked file on the phone and hands the bridge only its name, type, size and SHA-256; the
 * bridge checks the shared size and count limits before anything uploads (every type reaches
 * the agent, natively or as a file path, ADR 0034), then
 * runs the daemon's resumable upload (`context.request`: begin, chunks at the acknowledged
 * offset, commit), pulling each chunk from Swift as it goes: at most one 48 KiB chunk of a file
 * is in JavaScript at a time. Before a thread exists the files go into New thread's draft scope,
 * which the thread takes over when it starts. Refusals use the web's shared wording.
 */

type Result = ContextResult["result"];
/** Reads `limit` bytes of a staged file at `offset`, as base64. */
export type ChunkReader = (localId: string, offset: number, limit: number) => Promise<string>;
/** Where files upload: an existing thread, or a draft scope made on first use. */
export type UploadTarget = { threadId: ThreadId } | { draftId: () => Promise<string> };
/** One file's row for the tray Swift draws. */
export type TrayRow = Record<string, unknown>;

export const chunkBytes = 48 * 1024;

/** Staged files are read from Swift a chunk at a time (`Sources/Bridge/AttachmentStaging`). */
export const nativeChunks: ChunkReader = (localId, offset, limit) =>
  call("attachment.chunk", { localId, offset, limit });

export const Picked = z.object({
  localId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  name: z.string().min(1).max(255),
  mimeType: z.string().max(128),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type Picked = z.infer<typeof Picked>;

interface Staged extends Picked {
  state: "uploading" | "ready" | "failed";
  /**
   * A file the thread already stores, carried from a message (an edited one): it goes by
   * reference, never uploads again, and leaving the message never releases it from the thread.
   */
  carried: { itemId: string; thumbnail: boolean } | undefined;
  progress: number;
  error: string;
  uploadId: string | undefined;
  /** The draft scope it uploaded into, once made. */
  draftId: string | undefined;
  abort: AbortController;
}

export class AttachmentTray {
  readonly #client: Pick<ClientCore, "request">;
  readonly #target: UploadTarget;
  readonly #signal: AbortSignal;
  readonly #emit: (rows: TrayRow[]) => void;
  readonly #read: ChunkReader;
  readonly #files = new Map<string, Staged>();

  constructor(
    client: Pick<ClientCore, "request">,
    target: UploadTarget,
    signal: AbortSignal,
    emit: (rows: TrayRow[]) => void,
    read: ChunkReader,
  ) {
    this.#client = client;
    this.#target = target;
    this.#signal = signal;
    this.#emit = emit;
    this.#read = read;
    this.#publish();
  }

  /** How many files the message holds, uploaded or not. */
  get size(): number {
    return this.#files.size;
  }

  /** Stage a picked file; a refusal is said on its row and nothing uploads. */
  attach(picked: Picked): void {
    if (this.#files.has(picked.localId)) return;
    const held = [...this.#files.values()].filter((file) => file.state !== "failed");
    const problem =
      held.length >= attachmentLimits.perMessage
        ? `A message carries up to ${attachmentLimits.perMessage} files`
        : attachmentSizeProblem(
            picked.bytes,
            held.reduce((sum, file) => sum + file.bytes, 0),
          );
    const file: Staged = {
      ...picked,
      state: problem ? "failed" : "uploading",
      progress: 0,
      error: problem ?? "",
      uploadId: undefined,
      draftId: undefined,
      carried: undefined,
      abort: new AbortController(),
    };
    this.#files.set(picked.localId, file);
    this.#publish();
    if (!problem) void this.#upload(file);
  }

  /**
   * Put files message `itemId` carries on this message as they are: the same stored files, by
   * reference. Ones already on it, or past the per-message limit, are left off.
   */
  carry(itemId: string, files: readonly Attachment[]): void {
    for (const attachment of files) {
      if (this.#files.size >= attachmentLimits.perMessage) break;
      if ([...this.#files.values()].some((file) => file.sha256 === attachment.sha256)) continue;
      const localId = `carried-${attachment.sha256.slice(0, 32)}`;
      this.#files.set(localId, {
        localId,
        name: attachment.name,
        mimeType: attachment.mimeType,
        bytes: attachment.bytes,
        sha256: attachment.sha256,
        state: "ready",
        progress: 1,
        error: "",
        uploadId: undefined,
        draftId: undefined,
        carried: { itemId, thumbnail: attachment.thumbnailAvailable === true },
        abort: new AbortController(),
      });
    }
    this.#publish();
  }

  /** Take the carried files back off the message (the edit it came with was closed). */
  dropCarried(): void {
    let dropped = false;
    for (const [localId, file] of this.#files)
      if (file.carried) {
        this.#files.delete(localId);
        dropped = true;
      }
    if (dropped) this.#publish();
  }

  /** Take a file off the message: an upload stops, a held file is released. */
  detach(localId: string): void {
    const file = this.#files.get(localId);
    if (!file) return;
    this.#files.delete(localId);
    file.abort.abort();
    this.#publish();
    // The thread keeps a carried file: its message still shows it.
    if (file.carried) return;
    const release: ContextOperation | undefined =
      file.state === "ready"
        ? "threadId" in this.#target
          ? { op: "attachment.release", threadId: this.#target.threadId, sha256: file.sha256 }
          : file.draftId
            ? { op: "draft.attachment.release", draftId: file.draftId, sha256: file.sha256 }
            : undefined
        : file.uploadId
          ? { op: "upload.cancel", uploadId: file.uploadId }
          : undefined;
    if (release) void this.#ask(release).catch(() => {});
  }

  /** The files on the message, by name and type. */
  files(): { name: string; mimeType: string | undefined }[] {
    return [...this.#files.values()].map((file) => ({ name: file.name, mimeType: file.mimeType }));
  }

  /** Why the message can't go yet, or the context carrying the held files. */
  context(): { refused: string } | { context: MessageContext | undefined } {
    const files = [...this.#files.values()];
    if (files.some((file) => file.state === "uploading"))
      return { refused: "Wait for your files to finish uploading." };
    if (files.some((file) => file.state === "failed"))
      return { refused: "Remove the files that didn't upload, then send." };
    if (!files.length) return { context: undefined };
    const draftId = files.find((file) => file.draftId)?.draftId;
    return {
      context: {
        ...(draftId ? { draftId } : {}),
        mentions: [],
        attachments: [...new Set(files.map((file) => file.sha256))].map((sha256) => ({ sha256 })),
      },
    };
  }

  /** The message carrying the files was saved: they go with it. */
  sent(): void {
    if (!this.#files.size) return;
    this.#files.clear();
    this.#publish();
  }

  /** Stop every upload: the screen holding the tray went away. */
  dispose(): void {
    for (const file of this.#files.values()) file.abort.abort();
  }

  /** Stop every upload and empty the tray: the scope its files went into was released. */
  discard(): void {
    this.dispose();
    if (!this.#files.size) return;
    this.#files.clear();
    this.#publish();
  }

  async #begin(file: Staged, signal: AbortSignal) {
    const target = {
      sha256: file.sha256,
      bytes: file.bytes,
      ...(file.mimeType ? { mimeType: file.mimeType } : {}),
      name: file.name,
    };
    if ("threadId" in this.#target)
      return expectContext(
        await this.#ask({ op: "upload.begin", threadId: this.#target.threadId, ...target }, signal),
        "upload",
      );
    file.draftId = await this.#target.draftId();
    return expectContext(
      await this.#ask({ op: "draft.upload.begin", draftId: file.draftId, ...target }, signal),
      "upload",
    );
  }

  async #upload(file: Staged): Promise<void> {
    const signal = file.abort.signal;
    try {
      const begun = await this.#begin(file, signal);
      file.uploadId = begun.uploadId;
      let offset = begun.offset;
      while (offset < file.bytes) {
        const data = await this.#read(
          file.localId,
          offset,
          Math.min(chunkBytes, file.bytes - offset),
        );
        if (signal.aborted) return;
        const next = expectContext(
          await this.#ask({ op: "upload.chunk", uploadId: begun.uploadId, offset, data }, signal),
          "upload",
        );
        if (next.offset <= offset) throw new ContextError("The upload stopped making progress.");
        offset = next.offset;
        file.progress = Math.min(0.99, offset / Math.max(1, file.bytes));
        this.#publish();
      }
      expectContext(
        await this.#ask({ op: "upload.commit", uploadId: begun.uploadId }, signal),
        "attachment",
      );
      if (signal.aborted) return;
      file.state = "ready";
      file.progress = 1;
    } catch (error) {
      if (signal.aborted || this.#signal.aborted) return;
      file.state = "failed";
      file.error = preview(
        error instanceof ContextError ? error.message : "Connection lost. Remove it and try again.",
        256,
      );
    }
    this.#publish();
  }

  async #ask(operation: ContextOperation, signal?: AbortSignal): Promise<Result> {
    const reply = await this.#client.request(
      { type: "context.request", operation },
      { signal: signal ?? this.#signal },
    );
    return reply.result;
  }

  #publish(): void {
    this.#emit(
      [...this.#files.values()].map((file) => ({
        id: file.localId,
        name: preview(file.name, 128),
        kind: trayKind(file.mimeType),
        mimeType: file.mimeType,
        bytes: file.bytes,
        state: file.state,
        progress: file.progress,
        error: file.error,
        /** Where a carried file is read from (`native.attachment`), as its message shows it. */
        carried: file.carried
          ? { itemId: file.carried.itemId, ref: file.sha256, thumbnail: file.carried.thumbnail }
          : null,
      })),
    );
  }
}

/** How the phone draws a file on the next message: a picture or a video gets a preview. */
function trayKind(mimeType: string): "image" | "video" | "file" {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  return "file";
}
