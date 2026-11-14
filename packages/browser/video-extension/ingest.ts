import { encodeMediaFrame, type MediaFrame } from "@ace/media/frame";

/*
 * A capture's stream into ace-media (docs/media/plan.md, "Ingest framing"): one loopback
 * WebSocket to `ws://127.0.0.1:<port>/ingest`, a hello with the source's token, then one
 * binary `MediaFrame` per chunk, with no base64 step. The page's origin (this extension, or the
 * desktop's `app://video-encoder`) is the only one ace-media's WebSocket takes. Until the
 * socket is open, and after it fails, chunks go to the daemon as before, so switching loses
 * none: each chunk goes exactly one way.
 */

export interface IngestTarget {
  url: string;
  /** The source's single-use token. The sink owns these bytes and zeroes them on every end. */
  token: Uint8Array;
  epoch: number;
}

/** The part of a WebSocket the sink uses; a test passes its own. */
export interface IngestSocket {
  binaryType: "arraybuffer" | "blob";
  readonly bufferedAmount: number;
  addEventListener(type: "open" | "error" | "close", listener: () => void): void;
  send(data: Uint8Array<ArrayBuffer>): void;
  close(): void;
}

/** Past this much unsent on the socket, deltas are dropped until the next keyframe. */
const backlogLimit = 4 * 1024 * 1024;

const kindVideo = 1;
const kindAudio = 2;
const kindEnd = 4;
const kindHello = 5;

const none = new Uint8Array(0);

function frame(
  fields: Partial<MediaFrame> & Pick<MediaFrame, "kind" | "payload">,
): Uint8Array<ArrayBuffer> {
  return encodeMediaFrame({
    flags: 0,
    ageUs: 0,
    width: 0,
    height: 0,
    displayWidth: 0,
    displayHeight: 0,
    scale: 1000,
    rotation: 0,
    codec: 0,
    encode: 0,
    epoch: 0,
    codecString: "",
    description: none,
    extension: none,
    ...fields,
  });
}

/** The `MediaFrame` codec number of a WebCodecs video codec string. */
export function videoCodec(codec: string): number {
  if (codec.startsWith("avc1.") || codec.startsWith("avc3.")) return 2;
  if (codec.startsWith("hvc1.") || codec.startsWith("hev1.")) return 4;
  if (codec === "vp8") return 5;
  if (codec.startsWith("vp09.")) return 6;
  return 0;
}

export function base64Bytes(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

export interface VideoChunk {
  encode: number;
  key: boolean;
  codec: string;
  width: number;
  height: number;
  ageMs: number;
  epoch: number;
  description: Uint8Array | undefined;
  bytes: Uint8Array;
}

export interface AudioChunk {
  sampleRate: number;
  channels: number;
  ageMs: number;
  epoch: number;
  bytes: Uint8Array;
}

export class IngestSink {
  readonly #socket: IngestSocket;
  #token: Uint8Array;
  #open = false;
  #closed = false;
  readonly #lost: () => void;
  /**
   * `opened` runs once the hello is sent: chunks may go to it from then. `lost` runs if the
   * socket fails, ace-media closes it, or a send fails; chunks go back to the daemon. The token
   * is zeroed once the hello is sent, and on every way the sink can end before that.
   */
  constructor(
    target: IngestTarget,
    opened: () => void,
    lost: () => void,
    connect: (url: string) => IngestSocket = (url) => new WebSocket(url),
  ) {
    this.#lost = lost;
    this.#token = target.token;
    let socket: IngestSocket;
    try {
      socket = connect(target.url);
    } catch (error) {
      this.#wipe();
      throw error;
    }
    this.#socket = socket;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      if (this.#closed) return;
      try {
        socket.send(frame({ kind: kindHello, payload: this.#token }));
      } catch {
        this.#fail();
        return;
      } finally {
        this.#wipe();
      }
      this.#open = true;
      opened();
    });
    socket.addEventListener("error", () => this.#fail());
    socket.addEventListener("close", () => this.#fail());
  }

  #wipe(): void {
    this.#token.fill(0);
  }

  #fail(): void {
    this.#open = false;
    this.#wipe();
    if (this.#closed) return;
    this.#closed = true;
    this.#lost();
  }

  /** One frame, or the sink fails and the capture goes back to the daemon. */
  #send(bytes: Uint8Array<ArrayBuffer>): void {
    try {
      this.#socket.send(bytes);
    } catch {
      this.#fail();
    }
  }

  /** Taking chunks now. */
  open(): boolean {
    return this.#open;
  }

  /** Backed up: deltas should wait for a keyframe. */
  behind(): boolean {
    return this.#socket.bufferedAmount > backlogLimit;
  }

  video(chunk: VideoChunk): void {
    if (!this.#open) return;
    const description = chunk.key ? chunk.description : undefined;
    this.#send(
      frame({
        kind: kindVideo,
        flags: (chunk.key ? 1 : 0) | (description ? 4 : 0),
        ageUs: Math.min(0xffffffff, Math.round(chunk.ageMs * 1000)),
        width: chunk.width,
        height: chunk.height,
        displayWidth: chunk.width,
        displayHeight: chunk.height,
        codec: videoCodec(chunk.codec),
        encode: chunk.encode,
        epoch: chunk.epoch,
        codecString: chunk.codec,
        description: description ?? none,
        payload: chunk.bytes,
      }),
    );
  }

  audio(chunk: AudioChunk): void {
    if (!this.#open) return;
    const description = new Uint8Array(5);
    new DataView(description.buffer).setUint32(0, chunk.sampleRate);
    description[4] = chunk.channels;
    this.#send(
      frame({
        kind: kindAudio,
        flags: 4,
        ageUs: Math.min(0xffffffff, Math.round(chunk.ageMs * 1000)),
        codec: 9,
        epoch: chunk.epoch,
        codecString: "opus",
        description,
        payload: chunk.bytes,
      }),
    );
  }

  /** The producer goes back to the daemon: an end frame after the last chunk, then close. */
  close(): void {
    this.#wipe();
    if (this.#closed) return;
    this.#closed = true;
    if (this.#open) {
      try {
        this.#socket.send(frame({ kind: kindEnd, payload: none }));
      } catch {
        // The socket is already gone: ace-media marks the stream cut.
      }
    }
    this.#open = false;
    this.#socket.close();
  }
}
