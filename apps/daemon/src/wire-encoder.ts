import type { ServerMessage, DeliveryEvent } from "@ace/protocol";
import type { PluginServerMessage } from "@ace/protocol/plugins";

/** One encoder per server. Weak keys cannot retain disconnected threads or past batches. */
export const eventFrameBytes = 1024 * 1024;
export class WireEncoder {
  split(
    message: Extract<ServerMessage, { type: "events" }>,
  ): Extract<ServerMessage, { type: "events" }>[] {
    const frames: Extract<ServerMessage, { type: "events" }>[] = [];
    let events: DeliveryEvent[] = [];
    let afterSeq = message.afterSeq;
    let bytes = Buffer.byteLength(JSON.stringify({ ...message, events: [] })) + 64;
    const overhead = bytes;
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
    let value = this.events.get(event);
    if (value === undefined) {
      value = JSON.stringify(event);
      this.events.set(event, value);
    }
    return value;
  }
  eventBytes(event: DeliveryEvent): number {
    let bytes = this.sizes.get(event);
    if (bytes === undefined) {
      bytes = Buffer.byteLength(this.event(event));
      this.sizes.set(event, bytes);
    }
    return bytes;
  }
  private sizes = new WeakMap<DeliveryEvent, number>();
  private events = new WeakMap<DeliveryEvent, string>();
  encode(message: ServerMessage | PluginServerMessage): string {
    if (message.type !== "events") return JSON.stringify(message);
    const encoded = message.events.map((event) => this.event(event));
    return `{"type":"events","subscriptionId":${JSON.stringify(message.subscriptionId)},"afterSeq":${message.afterSeq},"throughSeq":${message.throughSeq},"events":[${encoded.join(",")}]}`;
  }
}
