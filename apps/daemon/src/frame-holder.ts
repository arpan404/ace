import type { ServerMessage } from "@ace/protocol";
import type { PluginServerMessage } from "@ace/protocol/plugins";
import type { LinkView } from "./link-estimate.ts";

/** How long a streamed delta may wait for company before its frame goes, on a fast link. */
export const frameHoldMs = 16;
/** Backlog past which a remote link counts as slow, and past which as very slow. */
export const slowBacklogBytes = 8 * 1024;
export const verySlowBacklogBytes = 64 * 1024;

/**
 * How long deltas wait to share a frame on `link`: 16 ms on loopback and on a remote link that
 * keeps up; on one that has a backlog, 100 ms, and 250 ms past 64 KiB, so more deltas share
 * one frame and one compression pass. Only streamed deltas ever wait (`mayHold`).
 */
export function frameHoldFor(link: LinkView | undefined): number {
  if (!link?.remote) return frameHoldMs;
  // The backlog as the hold starts: bytes still queued when a new delta comes mean the link
  // is not keeping up. (The smoothed figure is sampled only on writes, so after one large
  // snapshot it could stay high on a fast link while few writes go.)
  const backlog = link.backlogBytes;
  return backlog >= verySlowBacklogBytes ? 250 : backlog >= slowBacklogBytes ? 100 : frameHoldMs;
}
/** A packed frame goes once it holds this many bytes, whatever the clock says. */
export const heldFrameBytes = 64 * 1024;

/**
 * Whether a message may wait (`frameHoldFor`) for later ones to share its frame: only
 * events made entirely of streamed text. Anything a person or a request waits on (approvals,
 * interactions, status, errors, acks, replies) goes at once, taking what waits before it.
 */
export function mayHold(message: ServerMessage | PluginServerMessage): boolean {
  return message.type === "events" && message.events.every(isDelta);
}

export function isDelta(event: { payload: { type: string } }): boolean {
  return event.payload.type === "item.delta";
}

/**
 * Packs a client's outgoing text frames into fewer WebSocket frames, for a client whose hello
 * said `framing: ["lines"]`: each message's JSON on its own line, in the order they were added.
 * Every part it holds may be compressed; the outbox sends anything else alone, after
 * releasing what is held, so a frame never mixes what the compression policy keeps apart.
 */
export class FrameHolder {
  #parts: string[] = [];
  #bytes = 0;
  #cancel: (() => void) | undefined;
  #send: (text: string) => void;
  #delay: (callback: () => void, milliseconds: number) => () => void;
  #holdMs: () => number;
  constructor(
    send: (text: string) => void,
    delay: (callback: () => void, milliseconds: number) => () => void,
    /** How long the first held part may wait, read when it starts waiting. */
    holdMs: () => number = () => frameHoldMs,
  ) {
    this.#send = send;
    this.#delay = delay;
    this.#holdMs = holdMs;
  }
  /** Bytes held and not yet handed to the socket; they count against the outbox budget. */
  get bytes(): number {
    return this.#bytes;
  }
  /** Hold `encoded` (`bytes` long) behind what is held; `hold` false sends everything now. */
  add(encoded: string, bytes: number, hold: boolean): void {
    if (this.#parts.length && this.#bytes + 1 + bytes > heldFrameBytes) this.release();
    this.#bytes += this.#parts.length ? bytes + 1 : bytes;
    this.#parts.push(encoded);
    if (!hold || this.#bytes >= heldFrameBytes) this.release();
    else
      this.#cancel ??= this.#delay(() => {
        this.#cancel = undefined;
        this.release();
      }, this.#holdMs());
  }
  /** Send what is held, as one frame. */
  release(): void {
    this.#cancel?.();
    this.#cancel = undefined;
    const parts = this.#parts;
    if (!parts.length) return;
    this.#parts = [];
    this.#bytes = 0;
    this.#send(parts.length === 1 ? (parts[0] ?? "") : parts.join("\n"));
  }
  /** Drop what is held: the socket is resyncing or gone. */
  clear(): void {
    this.#cancel?.();
    this.#cancel = undefined;
    this.#parts = [];
    this.#bytes = 0;
  }
}
