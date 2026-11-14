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
 * Interactive fragments in a row while bulk waits, before bulk gets one: bulk always finishes,
 * and an interactive message waits behind at most one bulk fragment.
 */
export const INTERACTIVE_RUN = 8;

/**
 * The messages a channel has yet to send, in one lane or two. Without lanes every message waits
 * for the one before it, and a message's fragments go back to back: what an older reader needs.
 *
 * With lanes, the next fragment comes from the interactive lane's first message when it is
 * ready, else from the bulk lane's. Only an interactive message ever goes ahead of an earlier
 * one: a bulk message never passes an interactive message admitted before it, even one still
 * being deflated, so a message routed to bulk (and `channel.close`, which always is) is a fence
 * behind everything admitted before it. Order within a lane always holds. After
 * `INTERACTIVE_RUN` interactive fragments in a row with bulk ready, bulk sends one. Pure.
 */
export class SendQueue {
  readonly #lanes: { message: QueuedMessage; admitted: number }[][] = [[], []];
  #interleave = false;
  #bytes = [0, 0];
  #admitted = 0;
  #run = 0;

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
    this.#lanes[message.lane]?.push({ message, admitted: ++this.#admitted });
    this.#bytes[message.lane] = this.bytesIn(message.lane) + message.bytes;
  }

  /** A queued message's count changed (its deflate finished smaller). */
  recount(message: QueuedMessage, bytes: number): void {
    this.#bytes[message.lane] = this.bytesIn(message.lane) - message.bytes + bytes;
    message.bytes = bytes;
  }

  /** The message whose next fragment goes now, if any may go. */
  next(): QueuedMessage | undefined {
    const interactive = this.#lanes[INTERACTIVE]?.[0];
    const bulk = this.#lanes[BULK]?.[0];
    // Bulk may go only once nothing interactive admitted before it is still queued.
    const bulkReady =
      bulk?.message.data !== undefined && (!interactive || interactive.admitted > bulk.admitted);
    const interactiveReady = interactive?.message.data !== undefined;
    if (interactiveReady && !(bulkReady && this.#run >= INTERACTIVE_RUN))
      return interactive.message;
    return bulkReady ? bulk.message : undefined;
  }

  /** One fragment of `message` went: counts toward bulk's share. */
  sent(message: QueuedMessage): void {
    if (message.lane === INTERACTIVE && (this.#lanes[BULK]?.length ?? 0) > 0) this.#run++;
    else this.#run = 0;
  }

  /** `message`, the first of its lane, was sent in full. */
  finish(message: QueuedMessage): void {
    const lane = this.#lanes[message.lane];
    if (lane?.[0]?.message !== message) return;
    lane.shift();
    this.#bytes[message.lane] = this.bytesIn(message.lane) - message.bytes;
  }

  /** Every queued message, removed: the channel ended. */
  drain(): QueuedMessage[] {
    const all = this.#lanes.flatMap((lane) => lane.splice(0).map((entry) => entry.message));
    this.#bytes = [0, 0];
    return all;
  }
}
