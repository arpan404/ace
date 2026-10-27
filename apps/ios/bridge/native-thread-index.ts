import type { ClientCore } from "@ace/client";
import { ThreadId, type Attachment } from "@ace/protocol";
import { formatBytes } from "@ace/ui-core/byte-size";
import { oneLine, sanitizeUserText } from "@ace/ui-core";
import { z } from "zod";
import { preview } from "./presentation.ts";

/*
 * Two of the thread menu's lists, read on demand: the thread's turns (ADR 0062's turn index,
 * newest first, a page at a time) with the ask and the reply's opening at a glance, and the files
 * stored for the thread, which can be removed. Display text is bounded; ordinals and hashes exact.
 */

export const NativeTurnsRequest = z.object({
  type: z.literal("native.turns"),
  threadId: ThreadId,
  /** The page before this ordinal (exclusive); the newest page when absent. */
  before: z.number().int().positive().optional(),
});

/** One turn's row: its number, the ask on one line and the reply's opening. */
export function turnRow(turn: {
  ordinal: number;
  startedAt: number;
  outcome: string;
  initiatingMessagePreview?: string | undefined;
  latestAgentMessagePreview?: string | undefined;
}) {
  return {
    ordinal: turn.ordinal,
    startedAt: turn.startedAt,
    outcome: turn.outcome,
    ask: preview(oneLine(sanitizeUserText(turn.initiatingMessagePreview ?? "")), 256),
    reply: preview(oneLine(sanitizeUserText(turn.latestAgentMessagePreview ?? "")), 512),
  };
}

export async function readNativeTurns(
  owner: ClientCore,
  request: z.infer<typeof NativeTurnsRequest>,
  signal: AbortSignal,
) {
  const page = await owner.turnsPage(
    {
      threadId: request.threadId,
      limit: 50,
      ...(request.before ? { before: request.before } : {}),
    },
    { signal },
  );
  return {
    turns: page.turns.map(turnRow).toReversed(),
    /** The next page reads before this ordinal; null at the first turn. */
    older: page.before,
    ready: page.ready,
  };
}

export const NativeThreadFilesRequest = z.object({
  type: z.literal("native.threadFiles"),
  threadId: ThreadId,
  /** Remove this stored file first, then list what is left. */
  release: z.string().min(1).max(128).optional(),
});

/** A stored file's row: its name, size in words and how it opens (`native.attachment` ref). */
export function threadFileRow(file: Attachment) {
  return {
    ref: file.sha256,
    name: preview(file.name, 255),
    size: formatBytes(file.bytes),
    mimeType: preview(file.mimeType, 128),
    kind: file.kind ?? (file.mimeType.startsWith("image/") ? "image" : "binary"),
    width: file.width ?? 0,
    height: file.height ?? 0,
    thumbnail: file.thumbnailAvailable === true,
  };
}

/**
 * The Attachments lists last read, per thread (a few threads at most), so opening one of the
 * listed files reads it at once instead of listing the thread again first.
 */
export class ThreadFileIndex {
  readonly #lists = new Map<string, readonly Attachment[]>();
  static readonly kept = 8;
  remember(threadId: string, files: readonly Attachment[]): void {
    this.#lists.delete(threadId);
    this.#lists.set(threadId, files);
    for (const oldest of this.#lists.keys()) {
      if (this.#lists.size <= ThreadFileIndex.kept) break;
      this.#lists.delete(oldest);
    }
  }
  /** The file, when the thread's last list held it; undefined when it must be listed again. */
  find(threadId: string, sha256: string): Attachment | undefined {
    return this.#lists.get(threadId)?.find((file) => file.sha256 === sha256);
  }
}

/** Why a file can't be removed while the fork being written carries it. */
export const carriedFileRefused =
  "This file is on the fork you're writing. Take it off the fork's message first.";

export async function readNativeThreadFiles(
  owner: ClientCore,
  request: z.infer<typeof NativeThreadFilesRequest>,
  signal: AbortSignal,
  index: ThreadFileIndex = new ThreadFileIndex(),
  /** The files the fork being written in this thread carries, which must stay. */
  carried: ReadonlySet<string> = new Set(),
) {
  const ask = (operation: Parameters<ClientCore["request"]>[0] & { type: "context.request" }) =>
    owner.request(operation, { signal });
  let refused: string | null = null;
  if (request.release && carried.has(request.release)) refused = carriedFileRefused;
  else if (request.release) {
    const released = await ask({
      type: "context.request",
      operation: { op: "attachment.release", threadId: request.threadId, sha256: request.release },
    });
    if (released.result.kind !== "ok") refused = "Couldn't remove this file. Try again.";
  }
  const listed = await ask({
    type: "context.request",
    operation: { op: "attachment.list", threadId: request.threadId },
  });
  if (listed.result.kind !== "attachments") throw new Error("Couldn't load the files.");
  index.remember(request.threadId, listed.result.attachments);
  return { files: listed.result.attachments.map(threadFileRow), refused };
}
