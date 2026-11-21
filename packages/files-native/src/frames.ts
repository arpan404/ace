/**
 * The frames ace-files and ace-history speak on stdio (`native/files/crates/files-wire/src/frame.rs`,
 * which `native/history/crates/history-wire` shares): a `u32` little-endian length covering the
 * kind byte and the payload, then kind `1` (UTF-8 JSON) or kind `2` (`u64` LE id and raw bytes).
 * The limits and the decoder's behaviour on a broken stream are the Rust ones. What the JSON
 * means is each protocol's own: `wire.ts` here, history-import's messages there.
 */

/** The largest length a frame may declare: the kind byte plus the payload. */
export const MAX_FRAME_LEN = 16 * 1024 * 1024;
/** The largest body a kind-2 frame can carry: the frame limit less the kind byte and the id. */
export const MAX_BODY_LEN = MAX_FRAME_LEN - 9;

const HEADER_LEN = 4;
const KIND_LEN = 1;
const ID_LEN = 8;
const JSON_KIND = 1;
const BODY_KIND = 2;

/** Why a frame could not be read or written. */
export type FilesWireCode = "TOO_LARGE" | "INVALID_ARGUMENT" | "UNSUPPORTED";

/** A framing failure, carrying the code the daemon reports and any request id it recovered. */
export class FilesWireError extends Error {
  readonly code: FilesWireCode;
  readonly id: number | undefined;

  constructor(code: FilesWireCode, message: string, id?: number) {
    super(message);
    this.name = "FilesWireError";
    this.code = code;
    this.id = id;
  }
}

/** One raw frame: a JSON payload not yet decoded, or a body and the id it belongs to. */
export type RawFrame =
  | { kind: "json"; payload: Uint8Array }
  | { kind: "body"; id: number; bytes: Uint8Array };

/** Encode a UTF-8 JSON payload as one kind-1 frame. */
export function encodeJson(payload: Uint8Array): Uint8Array {
  return frame(JSON_KIND, payload);
}

/** Encode a binary body as one kind-2 frame for the request `id`. */
export function encodeBody(id: number, bytes: Uint8Array): Uint8Array {
  if (!Number.isSafeInteger(id) || id < 0)
    throw new FilesWireError("INVALID_ARGUMENT", `request id ${id} is not a safe integer`);
  if (bytes.length > MAX_BODY_LEN)
    throw new FilesWireError(
      "TOO_LARGE",
      `body of ${ID_LEN + KIND_LEN + bytes.length} bytes exceeds the 16 MiB frame limit`,
    );
  const payload = new Uint8Array(ID_LEN + bytes.length);
  new DataView(payload.buffer).setBigUint64(0, BigInt(id), true);
  payload.set(bytes, ID_LEN);
  return frame(BODY_KIND, payload);
}

/** Prefix `payload` with its declared length and kind byte, refusing frames over the limit. */
function frame(kind: number, payload: Uint8Array): Uint8Array {
  const length = payload.length + KIND_LEN;
  if (length > MAX_FRAME_LEN)
    throw new FilesWireError("TOO_LARGE", `frame of ${length} bytes exceeds the 16 MiB limit`);
  const bytes = new Uint8Array(HEADER_LEN + length);
  new DataView(bytes.buffer).setUint32(0, length, true);
  bytes[HEADER_LEN] = kind;
  bytes.set(payload, HEADER_LEN + KIND_LEN);
  return bytes;
}

/**
 * Reads frames out of the chunks stdio hands over, which may split or join frames at any byte.
 * A message that fails to parse costs that frame only; the boundary was known, so the next call
 * reads the next frame. A declaration over `MAX_FRAME_LEN` ends the stream: it is reported on
 * this call and every later one, while `push` drops what still arrives so a dead decoder holds
 * no memory.
 */
export class RawFrameDecoder {
  #chunks: Uint8Array[] = [];
  #buffered = 0;
  #dead: number | undefined;

  /** Hand the next chunk in; ignored once the stream is dead. */
  push(chunk: Uint8Array): void {
    if (this.#dead !== undefined || chunk.length === 0) return;
    this.#chunks.push(chunk);
    this.#buffered += chunk.length;
  }

  /** How many bytes are held for frames not yet decoded. */
  bufferedBytes(): number {
    return this.#buffered;
  }

  /** Take the next complete frame, or `undefined` when more bytes are needed. */
  poll(): RawFrame | undefined {
    if (this.#dead !== undefined)
      throw new FilesWireError(
        "TOO_LARGE",
        `frame of ${this.#dead} bytes exceeds the 16 MiB limit`,
      );
    if (this.#buffered < HEADER_LEN) return undefined;
    const head = this.#peek(HEADER_LEN);
    const length = new DataView(head.buffer, head.byteOffset, HEADER_LEN).getUint32(0, true);
    if (length > MAX_FRAME_LEN) {
      this.#dead = length;
      this.#chunks = [];
      this.#buffered = 0;
      throw new FilesWireError("TOO_LARGE", `frame of ${length} bytes exceeds the 16 MiB limit`);
    }
    if (length === 0) {
      this.#take(HEADER_LEN);
      throw new FilesWireError("INVALID_ARGUMENT", "frame declares no kind byte");
    }
    if (this.#buffered < HEADER_LEN + length) return undefined;
    const complete = this.#take(HEADER_LEN + length);
    const kind = complete[HEADER_LEN] ?? 0;
    const payload = complete.subarray(HEADER_LEN + KIND_LEN);
    if (kind === JSON_KIND) return { kind: "json", payload };
    if (kind === BODY_KIND) return decodeBody(payload);
    throw new FilesWireError("UNSUPPORTED", `unknown frame kind ${kind}`);
  }

  #peek(count: number): Uint8Array {
    const first = this.#chunks[0];
    if (first && first.length >= count) return first.subarray(0, count);
    const out = new Uint8Array(count);
    let offset = 0;
    for (const chunk of this.#chunks) {
      const part = chunk.subarray(0, count - offset);
      out.set(part, offset);
      offset += part.length;
      if (offset === count) break;
    }
    return out;
  }

  #take(count: number): Uint8Array {
    const out = new Uint8Array(count);
    let offset = 0;
    while (offset < count) {
      const chunk = this.#chunks[0];
      if (!chunk) throw new Error("RawFrameDecoder underflow");
      const part = chunk.subarray(0, count - offset);
      out.set(part, offset);
      offset += part.length;
      if (part.length === chunk.length) this.#chunks.shift();
      else this.#chunks[0] = chunk.subarray(part.length);
    }
    this.#buffered -= count;
    return out;
  }
}

/** Split a kind-2 payload into its request id and bytes. */
function decodeBody(payload: Uint8Array): RawFrame {
  if (payload.length < ID_LEN)
    throw new FilesWireError(
      "INVALID_ARGUMENT",
      `body frame of ${payload.length} payload bytes has no room for a request id`,
    );
  const raw = new DataView(payload.buffer, payload.byteOffset, ID_LEN).getBigUint64(0, true);
  const id = Number(raw);
  if (!Number.isSafeInteger(id))
    throw new FilesWireError("INVALID_ARGUMENT", `body frame id ${raw} is not safe in JSON`);
  return { kind: "body", id, bytes: payload.slice(ID_LEN) };
}
