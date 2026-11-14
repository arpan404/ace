import { BULK, INTERACTIVE, type FragmentKind, type Lane } from "@ace/secure-channel";

/** One message waiting to go, fragment by fragment. */
export interface QueuedMessage {
  readonly lane: Lane;
  /** Set once known: a message being deflated may still go as plain JSON. */
  kind: FragmentKind;
  /** Its bytes; undefined while they are still being deflated. */
  data: Uint8Array | undefined;
  /** Bytes already sent. */
  offset: number;
  /** What it counts in the channel's queued bytes. */
  bytes: number;
  settle(error?: Error): void;
}

/**
 * The messages a channel has yet to send, in one lane or two. Without lanes every message waits
 * for the one before it, and a message's fragments go back to back: what an older reader needs.
 * With lanes, the next fragment comes from the interactive lane's first message when it is ready
 * and from the bulk lane's otherwise. Order within a lane always holds: a message still being
 * deflated holds back the ones behind it in its lane, never the other lane. Pure.
 */
export class SendQueue {
  readonly #lanes: QueuedMessage[][] = [[], []];
  #interleave = false;
  #bytes = [0, 0];

  /** Lanes from now on; only for a peer that announced it reads them. */
  interleave(): void {
    this.#interleave = true;
  }

  get interleaving(): boolean {
    return this.#interleave;
  }

  /** The lane a message asking for `lane` goes in: always the interactive one without lanes. */
  laneFor(lane: Lane): Lane {
    return this.#interleave ? lane : INTERACTIVE;
  }

  /** Queued bytes in `lane`, as messages count them. */
  bytesIn(lane: Lane): number {
    return this.#bytes[lane] ?? 0;
  }

  push(message: QueuedMessage): void {
    this.#lanes[message.lane]?.push(message);
    this.#bytes[message.lane] = this.bytesIn(message.lane) + message.bytes;
  }

  /** A queued message's count changed (its deflate finished smaller). */
  recount(message: QueuedMessage, bytes: number): void {
    this.#bytes[message.lane] = this.bytesIn(message.lane) - message.bytes + bytes;
    message.bytes = bytes;
  }

  /** The message whose next fragment goes now, if any is ready. */
  next(): QueuedMessage | undefined {
    for (const lane of [INTERACTIVE, BULK]) {
      const head = this.#lanes[lane]?.[0];
      if (head?.data) return head;
    }
    return undefined;
  }

  /** `message`, the first of its lane, was sent in full. */
  finish(message: QueuedMessage): void {
    if (this.#lanes[message.lane]?.[0] !== message) return;
    this.#lanes[message.lane]?.shift();
    this.#bytes[message.lane] = this.bytesIn(message.lane) - message.bytes;
  }

  /** Every queued message, removed: the channel ended. */
  drain(): QueuedMessage[] {
    const all = this.#lanes.flatMap((lane) => lane.splice(0));
    this.#bytes = [0, 0];
    return all;
  }
}
