import { z } from "zod";
import { Envelope, object, string, type CursorEnvelope } from "./contracts.ts";

const BatchBody = z.object({ frames: z.array(Envelope).min(1).max(1024) });

/** Starts a timer; the returned call cancels it. Injected so tests drive time. */
export type BatchTimer = (run: () => void, ms: number) => () => void;
export const realTimer: BatchTimer = (run, ms) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

/**
 * The stretch a frame continues, if any: consecutive frames of one stretch may wait for the
 * window; anything else, and the first frame of a stretch, goes at once. So a thought, a tool or
 * a command shows the moment it starts, and only its following chunks are coalesced.
 */
export function stretchOf(frame: CursorEnvelope): string | undefined {
  const body = object(frame.body);
  const scope = `${frame.operationId}:${frame.segment}`;
  if (frame.kind === "recovered") return `${scope}:recovered`;
  if (frame.kind === "shell-output")
    return `${scope}:output:${string(body.callId) ?? string(body.parentCallId) ?? ""}`;
  if (frame.kind !== "delta") return undefined;
  const type = string(body.type);
  if (type === "text-delta" || type === "thinking-delta") return `${scope}:${type}`;
  if (type === "shell-output-delta" || type === "tool-call-delta")
    return `${scope}:${type}:${string(body.callId) ?? ""}`;
  return undefined;
}

/** Plain text chunks of one stretch with nothing else on them join into one frame. */
function mergeable(frame: CursorEnvelope): boolean {
  if (frame.kind !== "delta" || frame.raw) return false;
  const body = object(frame.body);
  const keys = Object.keys(body);
  return (
    (body.type === "text-delta" || body.type === "thinking-delta") &&
    typeof body.text === "string" &&
    keys.every((key) => key === "type" || key === "text")
  );
}
function merge(frames: CursorEnvelope[]): CursorEnvelope[] {
  const merged: CursorEnvelope[] = [];
  for (const frame of frames) {
    const last = merged.at(-1);
    if (
      last &&
      mergeable(last) &&
      mergeable(frame) &&
      last.operationId === frame.operationId &&
      last.segment === frame.segment &&
      last.runId === frame.runId &&
      object(last.body).type === object(frame.body).type
    ) {
      const text = `${string(object(last.body).text) ?? ""}${string(object(frame.body).text) ?? ""}`;
      merged[merged.length - 1] = {
        ...frame,
        body: { type: object(frame.body).type, text },
      };
    } else merged.push(frame);
  }
  return merged;
}

/**
 * Coalesces the host's streamed frames (ADR 0043, amendment of 2026-11-22): a stretch of text or
 * output chunks waits up to `windowMs` or `maxBytes`, then goes as one frame the daemon
 * acknowledges once and commits in one transaction. Frames keep their order: every send waits
 * for the one before it.
 */
export class FrameBatch {
  private frames: CursorEnvelope[] = [];
  private bytes = 0;
  private stretch: string | undefined;
  private cancelTimer: (() => void) | undefined;
  private tail: Promise<void> = Promise.resolve();
  private failure: unknown;
  private deliver: (frames: CursorEnvelope[]) => Promise<void>;
  private failed: (error: unknown) => void;
  private timer: BatchTimer;
  private windowMs: number;
  private maxBytes: number;
  /** `deliver` stores frames in order; `failed` hears a flush no caller was waiting on fail. */
  constructor(
    deliver: (frames: CursorEnvelope[]) => Promise<void>,
    failed: (error: unknown) => void,
    options: { timer?: BatchTimer; windowMs?: number; maxBytes?: number } = {},
  ) {
    this.deliver = deliver;
    this.failed = failed;
    this.timer = options.timer ?? realTimer;
    this.windowMs = options.windowMs ?? 32;
    this.maxBytes = options.maxBytes ?? 65536;
  }
  /**
   * Admits one frame of `bytes` encoded bytes. A continuing chunk resolves at once (its store
   * is awaited by the next frame that flushes); any other frame resolves when it is stored.
   */
  push(frame: CursorEnvelope, bytes: number): Promise<void> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    const stretch = stretchOf(frame);
    const continues = stretch !== undefined && stretch === this.stretch;
    this.stretch = stretch;
    // A frame that would overfill the batch goes after the frames already waiting.
    const before =
      this.frames.length && this.bytes + bytes > this.maxBytes ? this.flush() : undefined;
    this.frames.push(frame);
    this.bytes += bytes;
    if (!continues || this.bytes >= this.maxBytes) {
      const stored = this.flush();
      return before ? Promise.all([before, stored]).then(() => {}) : stored;
    }
    this.cancelTimer ??= this.timer(() => {
      this.flush().catch(() => {});
    }, this.windowMs);
    if (before) return before;
    return Promise.resolve();
  }
  /** Sends what is waiting now; resolves once it and everything before it is stored. */
  flush(): Promise<void> {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    const frames = this.frames;
    this.frames = [];
    this.bytes = 0;
    if (!frames.length) return this.tail;
    const sent = this.tail.then(() => {
      if (this.failure !== undefined) throw this.failure;
      return this.deliver(merge(frames));
    });
    this.tail = sent.catch((error: unknown) => {
      if (this.failure === undefined) {
        this.failure = error;
        this.failed(error);
      }
    });
    return sent;
  }
}

/** The frames one stored frame carries: a `batch`'s frames in order, or the frame itself. */
export function unbatch(frame: CursorEnvelope): CursorEnvelope[] {
  if (frame.kind !== "batch") return [frame];
  const parsed = BatchBody.safeParse(frame.body);
  if (!parsed.success) throw new Error("Malformed SDK frame batch");
  return parsed.data.frames;
}
