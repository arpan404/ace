import http2 from "node:http2";
import { pathToFileURL } from "node:url";

/*
 * The one Android emulator gRPC call ace makes: `EmulatorController.streamScreenshot`, with the
 * pixels delivered through shared memory (MMAP) so each message is a few bytes. The message
 * layouts follow the emulator's published interface (`emulator_controller.proto` in the SDK);
 * only the fields used here are encoded or read. Unknown fields are skipped, never fatal.
 */

/** `ImageFormat.ImgFormat.RGBA8888`, `ImageTransport.TransportChannel.MMAP`. */
const rgba8888 = 1;
const mmap = 1;
const screenshotPath = "/android.emulation.control.EmulatorController/streamScreenshot";
/** A reply larger than this is not a frame notice: the stream is refused. */
const messageLimit = 64 * 1024;

const varint = (value: number): number[] => {
  const bytes: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return bytes;
};
const lengthDelimited = (field: number, bytes: readonly number[]) => [
  (field << 3) | 2,
  ...varint(bytes.length),
  ...bytes,
];

/**
 * An `ImageFormat` asking for RGBA pictures that fit `width` × `height` (the emulator keeps the
 * aspect ratio and never upscales), written into the shared file `file`.
 */
export function screenshotRequest(input: { width: number; height: number; file: string }): Buffer {
  // A file URL the emulator maps: `file:///Users/…` on a Mac, `file:///C:/…` on Windows.
  const handle = Buffer.from(pathToFileURL(input.file).href);
  const transport = [0x08, mmap, ...lengthDelimited(2, [...handle])];
  return Buffer.from([
    0x08,
    rgba8888,
    0x18,
    ...varint(input.width),
    0x20,
    ...varint(input.height),
    ...lengthDelimited(6, transport),
  ]);
}

/** A field number to its varint value or bytes; repeated fields keep the last. */
function fields(message: Uint8Array): Map<number, number | Uint8Array> {
  const out = new Map<number, number | Uint8Array>();
  let offset = 0;
  const read = (): number => {
    let value = 0;
    let scale = 1;
    for (;;) {
      const byte = message[offset++];
      if (byte === undefined) throw new Error("Truncated emulator message");
      value += (byte & 0x7f) * scale;
      scale *= 128;
      if (byte < 0x80) return value;
    }
  };
  while (offset < message.length) {
    const tag = read();
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 0) out.set(field, read());
    else if (wire === 2) {
      const length = read();
      if (offset + length > message.length) throw new Error("Truncated emulator message");
      out.set(field, message.subarray(offset, offset + length));
      offset += length;
    } else if (wire === 1) offset += 8;
    else if (wire === 5) offset += 4;
    else throw new Error("Unknown emulator wire type");
  }
  return out;
}

/** One picture the emulator wrote into the shared file: its sequence and size. */
export interface ScreenNotice {
  seq: number;
  width: number;
  height: number;
  timestampUs: number;
}

const number = (value: unknown) => (typeof value === "number" ? value : 0);

/** An `Image` reply as a notice; width and height 0 when the display is off. */
export function screenNotice(message: Uint8Array): ScreenNotice {
  const image = fields(message);
  const format = image.get(1);
  const size = format instanceof Uint8Array ? fields(format) : new Map();
  return {
    seq: number(image.get(5)),
    width: number(size.get(3)),
    height: number(size.get(4)),
    timestampUs: number(image.get(6)),
  };
}

/** gRPC's framing: a compression flag and a 4-byte length before each message. */
export class GrpcMessages {
  #pending: Buffer = Buffer.alloc(0);
  readonly #emit: (message: Buffer) => void;
  constructor(emit: (message: Buffer) => void) {
    this.#emit = emit;
  }
  push(chunk: Buffer): void {
    this.#pending = this.#pending.length ? Buffer.concat([this.#pending, chunk]) : chunk;
    while (this.#pending.length >= 5) {
      if (this.#pending[0] !== 0) throw new Error("Compressed emulator message");
      const length = this.#pending.readUInt32BE(1);
      if (length > messageLimit) throw new Error("Emulator message exceeds limit");
      if (this.#pending.length < 5 + length) return;
      const message = this.#pending.subarray(5, 5 + length);
      this.#pending = this.#pending.subarray(5 + length);
      this.#emit(message);
    }
  }
}

export function grpcFrame(message: Buffer): Buffer {
  const frame = Buffer.alloc(5 + message.length);
  frame.writeUInt32BE(message.length, 1);
  message.copy(frame, 5);
  return frame;
}

/** A running screenshot stream; `close` ends it without a failure. */
export interface ScreenStream {
  close(): void;
}

/**
 * Streams the emulator's screen into `file` (sized for the largest picture) and calls `notice`
 * for each picture written. `failed` reports a stream that ended on its own.
 */
export function streamScreen(options: {
  port: number;
  token: string;
  width: number;
  height: number;
  file: string;
  notice(notice: ScreenNotice): void;
  failed(error: Error): void;
}): ScreenStream {
  let closed = false;
  const client = http2.connect(`http://127.0.0.1:${options.port}`);
  const fail = (error: Error) => {
    if (closed) return;
    closed = true;
    client.close();
    options.failed(error);
  };
  client.on("error", fail);
  const request = client.request({
    ":method": "POST",
    ":path": screenshotPath,
    "content-type": "application/grpc",
    te: "trailers",
    authorization: `Bearer ${options.token}`,
  });
  const messages = new GrpcMessages((message) => {
    if (!closed) options.notice(screenNotice(message));
  });
  request.on("data", (chunk: Buffer) => {
    try {
      messages.push(chunk);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
  request.on("trailers", (trailers) => {
    const status = trailers["grpc-status"];
    if (status && status !== "0")
      fail(new Error(`Emulator screen stream refused (gRPC ${String(status)})`));
  });
  request.on("response", (headers) => {
    const status = headers["grpc-status"];
    if (status && status !== "0")
      fail(new Error(`Emulator screen stream refused (gRPC ${String(status)})`));
  });
  request.on("error", fail);
  request.on("close", () => fail(new Error("Emulator screen stream ended")));
  request.end(grpcFrame(screenshotRequest(options)));
  return {
    close() {
      if (closed) return;
      closed = true;
      request.close();
      client.close();
    },
  };
}
