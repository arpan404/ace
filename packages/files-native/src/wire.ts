/**
 * files-wire messages (`native/files/crates/files-wire`) over the shared frames of `frames.ts`.
 */
import { FilesWireError, RawFrameDecoder, encodeJson } from "./frames.ts";
import { messageSchema, type Message } from "./schemas.ts";

export {
  MAX_FRAME_LEN,
  MAX_BODY_LEN,
  FilesWireError,
  encodeBody,
  type FilesWireCode,
} from "./frames.ts";

/** One decoded frame: a JSON message, or a body belonging to the response with its id. */
export type FilesFrame =
  | { kind: "message"; message: Message; text: string }
  | { kind: "body"; id: number; bytes: Uint8Array };

const encoder = new TextEncoder();
/** Fatal like serde: a kind-1 payload that is not valid UTF-8 is a broken message, not mojibake. */
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Encode a JSON message as one kind-1 frame. */
export function encodeMessage(message: Message): Uint8Array {
  const text = JSON.stringify(messageSchema.parse(message));
  return encodeJson(encoder.encode(text));
}

/**
 * Reads files-wire frames out of the chunks stdio hands over (see `RawFrameDecoder`), decoding
 * each JSON payload as a files-wire message. A message that fails to parse costs that frame only.
 */
export class FrameDecoder {
  #raw = new RawFrameDecoder();

  /** Hand the next chunk in; ignored once the stream is dead. */
  push(chunk: Uint8Array): void {
    this.#raw.push(chunk);
  }

  /** How many bytes are held for frames not yet decoded. */
  bufferedBytes(): number {
    return this.#raw.bufferedBytes();
  }

  /** Take the next complete frame, or `undefined` when more bytes are needed. */
  poll(): FilesFrame | undefined {
    const raw = this.#raw.poll();
    if (raw?.kind === "json") return decodeMessage(raw.payload);
    return raw;
  }
}

/** Parse one kind-1 payload, keeping the request id the bytes still carried on failure. */
function decodeMessage(payload: Uint8Array): FilesFrame {
  let text: string;
  try {
    text = decoder.decode(payload);
  } catch (error) {
    throw new FilesWireError("INVALID_ARGUMENT", `invalid message: ${reason(error)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new FilesWireError(
      "INVALID_ARGUMENT",
      `invalid message: ${reason(error)}`,
      probeId(text),
    );
  }
  const parsed = messageSchema.safeParse(value);
  if (!parsed.success)
    throw new FilesWireError(
      "INVALID_ARGUMENT",
      `invalid message: ${parsed.error.message}`,
      probeId(text),
    );
  return { kind: "message", message: parsed.data, text };
}

/** The id a broken payload still exposes, so a caller can fail the request it asked about. */
function probeId(text: string): number | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || !("id" in value)) return undefined;
    return typeof value.id === "number" && Number.isSafeInteger(value.id) && value.id >= 0
      ? value.id
      : undefined;
  } catch {
    return undefined;
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
