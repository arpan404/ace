import { encodeStill } from "@ace/browser/stream-still";
import { streamKinds } from "@ace/browser/stream";
import type { CapturedPicture } from "@ace/screen";

/** The binary half of one authenticated connection: stream pieces out, its backlog in. */
export interface StillTransport {
  write(piece: Uint8Array): Promise<void>;
  bufferedBytes(): number;
}

/**
 * A screenshot is refused rather than queued while the transport holds more than this: control
 * messages on the same channel must never find it backed up (the relay closes a channel whose
 * control replies can't get out).
 */
export const stillBacklogBytes = 128 * 1024;
/** Screenshots queued or being written at most. */
const queueLimit = 8;

/**
 * A person's device screenshots on one connection: each written whole, in order, as a still
 * (`encodeStill`). Live pictures never go this way: ace-media delivers them (X3). Each write
 * first runs its access check.
 */
export class StillWriter {
  readonly #transport: StillTransport;
  #tail: Promise<void> = Promise.resolve();
  #queued = 0;
  #ids = 0;
  #closed = false;
  constructor(transport: StillTransport) {
    this.#transport = transport;
  }
  /** One screenshot, resolved once its pieces are written; a backed-up connection refuses it. */
  write(deviceId: string, picture: CapturedPicture, guard: () => void): Promise<void> {
    if (this.#closed || this.#queued >= queueLimit)
      return Promise.reject(new Error("Screenshot writer unavailable or full"));
    if (this.#transport.bufferedBytes() > stillBacklogBytes)
      return Promise.reject(
        new Error("Screenshot delivery congested; retry when the connection recovers"),
      );
    const { bytes, codecNamed: _named, ...header } = picture;
    this.#ids = (this.#ids + 1) >>> 0;
    const pieces = encodeStill(streamKinds.deviceFrame, this.#ids, deviceId, header, bytes);
    this.#queued++;
    const next = this.#tail
      .then(async () => {
        if (this.#closed) throw new Error("Screenshot writer closed");
        guard();
        for (const piece of pieces) await this.#transport.write(piece);
      })
      .finally(() => {
        this.#queued--;
      });
    this.#tail = next.catch(() => {});
    return next;
  }
  close(): void {
    this.#closed = true;
  }
}
