import { createConnection, type Socket } from "node:net";
import { encodeMediaFrame, type MediaFrame } from "./frame.ts";

/**
 * A producer in the daemon writing to ace-media's ingest socket (an Android device's scrcpy
 * units, forwarded unchanged while its route says ace-media). The hello goes first with the
 * source's single-use token; units follow in order, never coalesced. Past `limit` queued bytes
 * deltas are dropped to the next keyframe and one is asked for, so a stalled reader never grows
 * the daemon and the stream stays decodable. `finish()` writes what is queued, then ends the
 * connection cleanly, which ace-media follows with the path's end marker. A connection that
 * fails, or that ace-media closes, is reported once.
 */

export type IngestWriterOptions = {
  socket: string;
  /** The source's 32-byte token; zeroed once the hello is written. */
  token: Uint8Array;
  onClosed: () => void;
  onKeyframe: () => void;
  /** Most bytes queued before deltas are dropped. */
  limit?: number;
  connect?: (path: string) => Socket;
};

export const ingestWriterLimit = 4 * 1024 * 1024;

export class IngestWriter {
  readonly #socket: Socket;
  readonly #options: IngestWriterOptions;
  #skipping = false;
  #ending = false;
  #closed = false;

  constructor(options: IngestWriterOptions) {
    this.#options = options;
    const socket = (options.connect ?? ((path) => createConnection(path)))(options.socket);
    this.#socket = socket;
    socket.on("error", () => {});
    socket.once("close", () => {
      const reported = !this.#ending && !this.#closed;
      this.#closed = true;
      if (reported) options.onClosed();
    });
    socket.write(encodeMediaFrame({ ...control(5), payload: options.token.slice() }));
    options.token.fill(0);
  }

  /** The connection is gone, or finishing. */
  get closed(): boolean {
    return this.#closed || this.#ending;
  }

  /** Queues one unit; false once closed or finishing. */
  write(frame: MediaFrame): boolean {
    if (this.closed) return false;
    const keyframe = (frame.flags & 1) !== 0;
    if (frame.kind === 1) {
      if (
        this.#socket.writableLength > (this.#options.limit ?? ingestWriterLimit) &&
        !this.#skipping
      ) {
        this.#skipping = true;
        this.#options.onKeyframe();
      }
      if (this.#skipping && !keyframe) return true;
      this.#skipping = false;
    }
    this.#socket.write(encodeMediaFrame(frame));
    return true;
  }

  /**
   * No more units: what is queued is written, then an end frame, then the connection ends. The
   * end frame is what makes ace-media's end marker a clean one; a connection that only closes
   * is a cut path.
   */
  finish(): void {
    if (this.closed) return;
    this.#ending = true;
    this.#socket.end(encodeMediaFrame({ ...control(4), payload: new Uint8Array(0) }));
  }

  /** At once, dropping what is queued: ace-media sees that path cut. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.destroy();
  }
}

/** A hello (5) or end (4) frame's fields, before its payload. */
function control(kind: 4 | 5): Omit<MediaFrame, "payload"> {
  return {
    kind,
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
    description: new Uint8Array(0),
    extension: new Uint8Array(0),
  };
}
