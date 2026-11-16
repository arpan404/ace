import type { ServerMessage, DeliveryEvent } from "@ace/protocol";
import type { PluginServerMessage } from "@ace/protocol/plugins";
import type { SuitServerMessage } from "@ace/protocol/suits";
import { EventEncodings } from "./event-encodings.ts";

/** What one connection's hello said it takes in place of whole events. */
export interface EventShape {
  /** Trim `raw-on-demand`: item events without the raw payloads clients only show. */
  rawOnDemand: boolean;
  /** Framing `short-deltas`: deltas in short form, their thread named once per message. */
  shortDeltas: boolean;
}
export const wholeEvents: EventShape = { rawOnDemand: false, shortDeltas: false };

type Events = Extract<ServerMessage, { type: "events" }>;

/** One encoder per server. Weak keys cannot retain disconnected threads or past batches. */
export const eventFrameBytes = 1024 * 1024;
export class WireEncoder {
  private readonly encodings: EventEncodings;
  /** `encodings` is shared with whoever else serialises the same events (the store's buffer). */
  constructor(encodings = new EventEncodings()) {
    this.encodings = encodings;
  }
  split(message: Events, shape: EventShape = wholeEvents): Events[] {
    const frames: Events[] = [];
    let events: DeliveryEvent[] = [];
    let afterSeq = message.afterSeq;
    // The envelope without events, and room for the throughSeq a split frame adds.
    const thread = shortThread(message, shape);
    const overhead = Buffer.byteLength(eventsPrefix(message, thread)) + 2 + 64;
    let bytes = overhead;
    for (const event of message.events) {
      const size = this.sized(event, shape, thread) + 1;
      if (events.length && bytes + size > eventFrameBytes) {
        const throughSeq = events.at(-1)?.seq ?? afterSeq;
        frames.push({ ...message, afterSeq, throughSeq, events });
        afterSeq = throughSeq;
        events = [];
        bytes = overhead;
      }
      events.push(event);
      bytes += size;
    }
    frames.push({ ...message, afterSeq, events });
    return frames;
  }
  /** UTF-8 length of `event` as a connection of `shape` receives it (never more than whole). */
  eventBytes(event: DeliveryEvent, shape: EventShape = wholeEvents): number {
    return takesTrimmed(event, shape)
      ? this.encodings.trimmedBytes(event)
      : this.encodings.bytes(event);
  }
  encode(
    message: ServerMessage | PluginServerMessage | SuitServerMessage,
    shape: EventShape = wholeEvents,
  ): string {
    if (message.type !== "events") return JSON.stringify(message);
    const thread = shortThread(message, shape);
    const encoded = message.events.map((event) => this.eventJson(event, shape, thread));
    return `${eventsPrefix(message, thread)}${encoded.join(",")}]}`;
  }
  /** UTF-8 length of `encode(message, shape)`, from each event's cached size: no frame is built. */
  encodedBytes(message: Events, shape: EventShape = wholeEvents): number {
    const thread = shortThread(message, shape);
    let bytes =
      Buffer.byteLength(eventsPrefix(message, thread)) + 2 + Math.max(0, message.events.length - 1);
    for (const event of message.events) bytes += this.sized(event, shape, thread);
    return bytes;
  }
  private sized(event: DeliveryEvent, shape: EventShape, thread: string | undefined): number {
    return trimmedHere(event, shape, thread)
      ? this.encodings.trimmedBytes(event)
      : this.encodings.bytes(event);
  }
  private eventJson(event: DeliveryEvent, shape: EventShape, thread: string | undefined): string {
    return trimmedHere(event, shape, thread)
      ? this.encodings.trimmedJson(event)
      : this.encodings.json(event);
  }
}

function takesTrimmed(event: DeliveryEvent, shape: EventShape): boolean {
  const type = event.payload.type;
  return type === "item.delta"
    ? shape.shortDeltas
    : shape.rawOnDemand && (type === "item.created" || type === "item.updated");
}

/** As `takesTrimmed`, in a message naming `thread`: a short delta of another thread goes whole. */
function trimmedHere(event: DeliveryEvent, shape: EventShape, thread: string | undefined): boolean {
  if (event.payload.type === "item.delta" && event.threadId !== thread) return false;
  return takesTrimmed(event, shape);
}

/**
 * The thread a short-deltas message names: its deltas' one thread, when the shape takes them.
 * Deltas of several threads (never on a thread subscription) all go whole, so a frame `split`
 * cuts from the message is never larger than it was weighed.
 */
function shortThread(message: Events, shape: EventShape): string | undefined {
  if (!shape.shortDeltas) return undefined;
  let thread: string | undefined;
  for (const event of message.events) {
    if (event.payload.type !== "item.delta") continue;
    if (thread !== undefined && event.threadId !== thread) return undefined;
    thread = event.threadId;
  }
  return thread;
}

function eventsPrefix(message: Events, thread: string | undefined): string {
  const named = thread === undefined ? "" : `"threadId":${JSON.stringify(thread)},`;
  const early = message.early ? `"early":true,` : "";
  return `{"type":"events","subscriptionId":${JSON.stringify(message.subscriptionId)},"afterSeq":${message.afterSeq},"throughSeq":${message.throughSeq},${early}${named}"events":[`;
}
