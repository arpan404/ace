import type { DeliveryEvent } from "@ace/protocol";
import { shortDeltaJson } from "@ace/projection/short-deltas";
import { omitRaw } from "@ace/projection/wire-trim";

interface Encoding {
  payload: unknown;
  json: string;
  bytes: number | undefined;
  /** The trimmed form (`trimmedJson`), once a client that takes it was sent this event. */
  trimmed: string | undefined;
  trimmedBytes: number | undefined;
}

/**
 * Each event's JSON, serialised once for everyone who weighs or sends it: the live write buffer
 * and the wire encoder see the same published objects. Weak keys retain nothing past the
 * event. Storing an event may replace its payload with a capped copy (`PayloadStore.cap`), so an
 * encoding counts only while the event still holds the payload it was made from.
 *
 * Besides the whole form, an event has at most one trimmed form, also made once and shared by
 * every connection that takes it: an item event without the raw payloads clients only show
 * (hello trim `raw-on-demand`), or a delta in short form (hello framing `short-deltas`). No
 * event is both, so one slot serves every mix of the two.
 */
export class EventEncodings {
  private encodings = new WeakMap<DeliveryEvent, Encoding>();
  private entry(event: DeliveryEvent): Encoding {
    let entry = this.encodings.get(event);
    if (entry === undefined || entry.payload !== event.payload) {
      entry = {
        payload: event.payload,
        json: JSON.stringify(event),
        bytes: undefined,
        trimmed: undefined,
        trimmedBytes: undefined,
      };
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
  /**
   * The trimmed form: a delta in short form (its thread named by the message around it), an item
   * event without the raw payloads clients only show, or the whole form for any other event.
   */
  trimmedJson(event: DeliveryEvent): string {
    const entry = this.entry(event);
    entry.trimmed ??= trimmed(event) ?? entry.json;
    return entry.trimmed;
  }
  /** UTF-8 length of `trimmedJson(event)`. */
  trimmedBytes(event: DeliveryEvent): number {
    const entry = this.entry(event);
    entry.trimmedBytes ??= Buffer.byteLength(this.trimmedJson(event));
    return entry.trimmedBytes;
  }
}

function trimmed(event: DeliveryEvent): string | undefined {
  const { payload } = event;
  if (payload.type === "item.delta") return shortDeltaJson(event);
  if (payload.type !== "item.created" && payload.type !== "item.updated") return undefined;
  const item = omitRaw(payload.item);
  return item === payload.item
    ? undefined
    : JSON.stringify({ ...event, payload: { ...payload, item } });
}
