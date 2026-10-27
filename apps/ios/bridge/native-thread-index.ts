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

export async function readNativeThreadFiles(
  owner: ClientCore,
  request: z.infer<typeof NativeThreadFilesRequest>,
  signal: AbortSignal,
) {
  const ask = (operation: Parameters<ClientCore["request"]>[0] & { type: "context.request" }) =>
    owner.request(operation, { signal });
  if (request.release) {
    const released = await ask({
      type: "context.request",
      operation: { op: "attachment.release", threadId: request.threadId, sha256: request.release },
    });
    if (released.result.kind !== "ok") throw new Error("Couldn't remove this file. Try again.");
  }
  const listed = await ask({
    type: "context.request",
    operation: { op: "attachment.list", threadId: request.threadId },
  });
  if (listed.result.kind !== "attachments") throw new Error("Couldn't load the files.");
  return { files: listed.result.attachments.map(threadFileRow) };
}
