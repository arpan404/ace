import type { ServerMessage } from "@ace/protocol";
import type { PluginServerMessage } from "@ace/protocol/plugins";

/** How long a streamed delta may wait for company before its frame goes. */
export const frameHoldMs = 16;
/** A packed frame goes once it holds this many bytes, whatever the clock says. */
export const heldFrameBytes = 64 * 1024;

/**
 * Whether a message may wait up to `frameHoldMs` for later ones to share its frame: only
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
  constructor(
    send: (text: string) => void,
    delay: (callback: () => void, milliseconds: number) => () => void,
  ) {
    this.#send = send;
    this.#delay = delay;
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
      }, frameHoldMs);
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
