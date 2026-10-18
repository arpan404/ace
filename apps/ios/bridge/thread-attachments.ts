import type { ClientCore } from "@ace/client";
import type { ContextOperation, ContextResult, MessageContext, ThreadId } from "@ace/protocol";
import {
  attachmentLimits,
  attachmentProblem,
  attachmentSizeProblem,
  type AttachmentReader,
} from "@ace/ui-core";
import { z } from "zod";
import { preview } from "./presentation.ts";

/*
 * Files and photos for the open thread's next message. Swift keeps the picked file on the phone
 * and hands the bridge only its name, type, size and SHA-256; the bridge checks the shared limits
 * and what the agent can read before anything uploads, then runs the daemon's resumable upload
 * (`context.request`: begin, chunks at the acknowledged offset, commit), pulling each chunk from
 * Swift as it goes: at most one 48 KiB chunk of a file is in JavaScript at a time. The tray's one
 * row carries each file's state and progress. A message carries the files the daemon holds.
 */

type Put = (key: string, read: () => Record<string, unknown> | undefined) => void;
type Result = ContextResult["result"];
/** Reads `limit` bytes of a staged file at `offset`, as base64. */
export type ChunkReader = (localId: string, offset: number, limit: number) => Promise<string>;

export const chunkBytes = 48 * 1024;

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
  progress: number;
  error: string;
  uploadId: string | undefined;
  abort: AbortController;
}

class UploadError extends Error {}

const expect = <K extends Result["kind"]>(
  result: Result,
  kind: K,
): Extract<Result, { kind: K }> => {
  if (result.kind === "error") throw new UploadError(result.message || "The upload failed");
  if (result.kind !== kind) throw new UploadError("ace answered something unexpected.");
  return result as Extract<Result, { kind: K }>;
};

export class AttachmentTray {
  readonly #client: ClientCore;
  readonly #threadId: ThreadId;
  readonly #signal: AbortSignal;
  readonly #put: Put;
  readonly #read: ChunkReader;
  readonly #files = new Map<string, Staged>();

  constructor(
    client: ClientCore,
    threadId: ThreadId,
    signal: AbortSignal,
    put: Put,
    read: ChunkReader,
  ) {
    this.#client = client;
    this.#threadId = threadId;
    this.#signal = signal;
    this.#put = put;
    this.#read = read;
    this.#emit();
  }

  /** Stage a picked file; a refusal is said on its row and nothing uploads. */
  attach(picked: Picked, reader: AttachmentReader | undefined): void {
    if (this.#files.has(picked.localId)) return;
    const held = [...this.#files.values()].filter((file) => file.state !== "failed");
    const problem =
      held.length >= attachmentLimits.perMessage
        ? `A message carries up to ${attachmentLimits.perMessage} files`
        : (attachmentSizeProblem(
            picked.bytes,
            held.reduce((sum, file) => sum + file.bytes, 0),
          ) ?? attachmentProblem({ name: picked.name, mimeType: picked.mimeType }, reader));
    const file: Staged = {
      ...picked,
      state: problem ? "failed" : "uploading",
      progress: 0,
      error: problem ?? "",
      uploadId: undefined,
      abort: new AbortController(),
    };
    this.#files.set(picked.localId, file);
    this.#emit();
    if (!problem) void this.#upload(file);
  }

  /** Take a file off the message: an upload stops, a held file is released. */
  detach(localId: string): void {
    const file = this.#files.get(localId);
    if (!file) return;
    this.#files.delete(localId);
    file.abort.abort();
    this.#emit();
    const release: ContextOperation | undefined =
      file.state === "ready"
        ? { op: "attachment.release", threadId: this.#threadId, sha256: file.sha256 }
        : file.uploadId
          ? { op: "upload.cancel", uploadId: file.uploadId }
          : undefined;
    if (release) void this.#ask(release).catch(() => {});
  }

  /** Why the message can't go yet, or the context carrying the held files. */
  context(): { refused: string } | { context: MessageContext | undefined } {
    const files = [...this.#files.values()];
    if (files.some((file) => file.state === "uploading"))
      return { refused: "Wait for your files to finish uploading." };
    if (files.some((file) => file.state === "failed"))
      return { refused: "Remove the files that didn't upload, then send." };
    if (!files.length) return { context: undefined };
    return {
      context: {
        mentions: [],
        attachments: [...new Set(files.map((file) => file.sha256))].map((sha256) => ({ sha256 })),
      },
    };
  }

  /** The message carrying the files was saved: they go with it. */
  sent(): void {
    if (!this.#files.size) return;
    this.#files.clear();
    this.#emit();
  }

  dispose(): void {
    for (const file of this.#files.values()) file.abort.abort();
  }

  async #upload(file: Staged): Promise<void> {
    const signal = file.abort.signal;
    try {
      const begun = expect(
        await this.#ask(
          {
            op: "upload.begin",
            threadId: this.#threadId,
            sha256: file.sha256,
            bytes: file.bytes,
            ...(file.mimeType ? { mimeType: file.mimeType } : {}),
            name: file.name,
          },
          signal,
        ),
        "upload",
      );
      file.uploadId = begun.uploadId;
      let offset = begun.offset;
      while (offset < file.bytes) {
        const data = await this.#read(
          file.localId,
          offset,
          Math.min(chunkBytes, file.bytes - offset),
        );
        if (signal.aborted) return;
        const next = expect(
          await this.#ask({ op: "upload.chunk", uploadId: begun.uploadId, offset, data }, signal),
          "upload",
        );
        if (next.offset <= offset) throw new UploadError("The upload stopped making progress.");
        offset = next.offset;
        file.progress = Math.min(0.99, offset / Math.max(1, file.bytes));
        this.#emit();
      }
      expect(
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
        error instanceof UploadError ? error.message : "Connection lost. Remove it and try again.",
        256,
      );
    }
    this.#emit();
  }

  async #ask(operation: ContextOperation, signal?: AbortSignal): Promise<Result> {
    const reply = await this.#client.request(
      { type: "context.request", operation },
      { signal: signal ?? this.#signal },
    );
    return reply.result;
  }

  #emit(): void {
    this.#put("attachments", () => ({
      type: "thread.attachments",
      files: [...this.#files.values()].map((file) => ({
        id: file.localId,
        name: preview(file.name, 128),
        kind: file.mimeType.startsWith("image/") ? "image" : "file",
        bytes: file.bytes,
        state: file.state,
        progress: file.progress,
        error: file.error,
      })),
    }));
  }
}
