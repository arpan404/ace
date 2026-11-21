import { RawFrameDecoder, encodeBody, encodeJson } from "@ace/files-native/frames";

/**
 * ace-history's messages (ADR 0207, `native/history/crates/history-wire`) over the frames it
 * shares with ace-files (`@ace/files-native/frames`). A `Uint8Array` inside a message travels as
 * a body frame sent just before the JSON, tagged with the message's id, and appears in the JSON
 * as `{"$body": n}`, the n-th body of that message.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** The frames of one message: its bodies first, then its JSON. `id` tags the bodies. */
export function encodeFrames(message: unknown, id = 0): Uint8Array[] {
  const bodies: Uint8Array[] = [];
  // The holder's own value, not `value`: a Buffer's toJSON runs before a replacer sees it.
  const text = JSON.stringify(message, function (this: unknown, key: string, value: unknown) {
    const original: unknown = key === "" ? value : Reflect.get(Object(this), key);
    if (original instanceof Uint8Array) {
      bodies.push(original);
      return { $body: bodies.length - 1 };
    }
    return value;
  });
  const tag = Math.max(0, id);
  return [...bodies.map((body) => encodeBody(tag, body)), encodeJson(encoder.encode(text))];
}

function isBodyRef(value: unknown): value is { $body: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 1 &&
    typeof Reflect.get(value, "$body") === "number"
  );
}

/** Reads messages out of the chunks a pipe hands over. Throws once the stream is broken. */
export class FrameReader {
  private frames = new RawFrameDecoder();
  private bodies: Uint8Array[] = [];
  push(chunk: Uint8Array): void {
    this.frames.push(chunk);
  }
  /** Every whole message buffered so far. */
  *messages(): Generator<unknown> {
    for (let frame = this.frames.poll(); frame; frame = this.frames.poll()) {
      if (frame.kind === "body") {
        this.bodies.push(frame.bytes);
        continue;
      }
      const bodies = this.bodies;
      this.bodies = [];
      yield JSON.parse(decoder.decode(frame.payload), (_key, value: unknown) =>
        isBodyRef(value) ? (bodies[value.$body] ?? new Uint8Array()) : value,
      );
    }
  }
}
