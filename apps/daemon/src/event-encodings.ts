import type { DeliveryEvent } from "@ace/protocol";

interface Encoding {
  payload: unknown;
  json: string;
  bytes: number | undefined;
}

/**
 * Each event's JSON, serialised once for everyone who weighs or sends it: the live write buffer
 * and the wire encoder see the same published objects. Weak keys retain nothing past the
 * event. Storing an event may replace its payload with a capped copy (`PayloadStore.cap`), so an
 * encoding counts only while the event still holds the payload it was made from.
 */
export class EventEncodings {
  private encodings = new WeakMap<DeliveryEvent, Encoding>();
  private entry(event: DeliveryEvent): Encoding {
    let entry = this.encodings.get(event);
    if (entry === undefined || entry.payload !== event.payload) {
      entry = { payload: event.payload, json: JSON.stringify(event), bytes: undefined };
      this.encodings.set(event, entry);
    }
    return entry;
  }
  json(event: DeliveryEvent): string {
    return this.entry(event).json;
  }
  /** UTF-8 length of `json(event)`. */
  bytes(event: DeliveryEvent): number {
    const entry = this.entry(event);
    entry.bytes ??= Buffer.byteLength(entry.json);
    return entry.bytes;
  }
}
