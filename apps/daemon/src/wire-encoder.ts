import type { ServerMessage, DeliveryEvent } from "@ace/protocol";
import type { PluginServerMessage } from "@ace/protocol/plugins";
import { EventEncodings } from "./event-encodings.ts";

/** One encoder per server. Weak keys cannot retain disconnected threads or past batches. */
export const eventFrameBytes = 1024 * 1024;
export class WireEncoder {
  private readonly encodings: EventEncodings;
  /** `encodings` is shared with whoever else serialises the same events (the store's buffer). */
  constructor(encodings = new EventEncodings()) {
    this.encodings = encodings;
  }
  split(
    message: Extract<ServerMessage, { type: "events" }>,
  ): Extract<ServerMessage, { type: "events" }>[] {
    const frames: Extract<ServerMessage, { type: "events" }>[] = [];
    let events: DeliveryEvent[] = [];
    let afterSeq = message.afterSeq;
    // The envelope without events, and room for the throughSeq a split frame adds.
    const overhead = Buffer.byteLength(eventsPrefix(message)) + 2 + 64;
    let bytes = overhead;
    for (const event of message.events) {
      const size = this.eventBytes(event) + 1;
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
  private event(event: DeliveryEvent): string {
    return this.encodings.json(event);
  }
  eventBytes(event: DeliveryEvent): number {
    return this.encodings.bytes(event);
  }
  encode(message: ServerMessage | PluginServerMessage): string {
    if (message.type !== "events") return JSON.stringify(message);
    const encoded = message.events.map((event) => this.event(event));
    return `${eventsPrefix(message)}${encoded.join(",")}]}`;
  }
  /** UTF-8 length of `encode(message)`, from each event's cached size: no frame is built. */
  encodedBytes(message: Extract<ServerMessage, { type: "events" }>): number {
    let bytes =
      Buffer.byteLength(eventsPrefix(message)) + 2 + Math.max(0, message.events.length - 1);
    for (const event of message.events) bytes += this.eventBytes(event);
    return bytes;
  }
}
function eventsPrefix(message: Extract<ServerMessage, { type: "events" }>): string {
  return `{"type":"events","subscriptionId":${JSON.stringify(message.subscriptionId)},"afterSeq":${message.afterSeq},"throughSeq":${message.throughSeq},"events":[`;
}
