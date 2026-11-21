/**
 * The framing between the daemon and ace-history (ADR 0206, `native/history/crates/history-wire`):
 * files-wire's frames, a `u32` little-endian length covering a kind byte and the payload, then
 * kind 1 (UTF-8 JSON) or kind 2 (`u64` LE message id, then bytes). A `Uint8Array` inside a message
 * travels as a body frame sent just before the JSON, and appears in it as `{"$body": n}`.
 */

export const MAX_FRAME_LEN = 16 * 1024 * 1024;
const HEADER_LEN = 4;
const ID_LEN = 8;
const JSON_KIND = 1;
const BODY_KIND = 2;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function frame(kind: number, payload: Uint8Array, prefix?: Uint8Array): Uint8Array {
  const length = 1 + (prefix?.length ?? 0) + payload.length;
  if (length > MAX_FRAME_LEN) throw new Error(`History frame of ${length} bytes is over 16 MiB`);
  const bytes = new Uint8Array(HEADER_LEN + length);
  new DataView(bytes.buffer).setUint32(0, length, true);
  bytes[HEADER_LEN] = kind;
  if (prefix) bytes.set(prefix, HEADER_LEN + 1);
  bytes.set(payload, HEADER_LEN + 1 + (prefix?.length ?? 0));
  return bytes;
}

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
  const tag = new Uint8Array(ID_LEN);
  new DataView(tag.buffer).setBigUint64(0, BigInt(Math.max(0, id)), true);
  return [
    ...bodies.map((body) => frame(BODY_KIND, body, tag)),
    frame(JSON_KIND, encoder.encode(text)),
  ];
}

function isBodyRef(value: unknown): value is { $body: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 1 &&
    typeof Reflect.get(value, "$body") === "number"
  );
}

/**
 * Reads messages out of the chunks a pipe hands over. A JSON frame that does not parse is
 * reported and skipped; a declaration over the limit ends the stream.
 */
export class FrameReader {
  private chunks: Uint8Array[] = [];
  private held = 0;
  private bodies: Uint8Array[] = [];
  private dead = false;
  push(chunk: Uint8Array): void {
    if (this.dead) return;
    this.chunks.push(chunk);
    this.held += chunk.length;
  }
  /** Every whole message buffered so far. Throws once the stream is broken. */
  *messages(): Generator<unknown> {
    for (;;) {
      if (this.dead) throw new Error("ace-history sent a frame over the 16 MiB limit");
      if (this.held < HEADER_LEN) return;
      const header = this.peek(HEADER_LEN);
      const length = new DataView(header.buffer, header.byteOffset, HEADER_LEN).getUint32(0, true);
      if (length > MAX_FRAME_LEN || length === 0) {
        this.dead = true;
        this.chunks = [];
        throw new Error("ace-history sent a broken frame");
      }
      if (this.held < HEADER_LEN + length) return;
      const bytes = this.take(HEADER_LEN + length).subarray(HEADER_LEN);
      const kind = bytes[0];
      if (kind === BODY_KIND) {
        // A plain Uint8Array, never a Buffer view of the pipe's chunk.
        const body = new Uint8Array(bytes.length - 1 - ID_LEN);
        body.set(bytes.subarray(1 + ID_LEN));
        this.bodies.push(body);
        continue;
      }
      if (kind !== JSON_KIND) continue;
      const bodies = this.bodies;
      this.bodies = [];
      yield JSON.parse(decoder.decode(bytes.subarray(1)), (_key, value: unknown) =>
        isBodyRef(value) ? (bodies[value.$body] ?? new Uint8Array()) : value,
      );
    }
  }
  private peek(count: number): Uint8Array {
    const first = this.chunks[0];
    if (first && first.length >= count) return first.subarray(0, count);
    return this.flatten().subarray(0, count);
  }
  private take(count: number): Uint8Array {
    const all = this.flatten();
    const taken = all.subarray(0, count);
    const rest = all.subarray(count);
    this.chunks = rest.length ? [rest] : [];
    this.held = rest.length;
    return taken;
  }
  private flatten(): Uint8Array {
    if (this.chunks.length === 1 && this.chunks[0]) return this.chunks[0];
    const all = new Uint8Array(this.held);
    let offset = 0;
    for (const chunk of this.chunks) {
      all.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [all];
    return all;
  }
}
