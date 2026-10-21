import { encodePicture, type PictureKind } from "./stream-picture.ts";
import { PictureViewer, type CapturedPicture } from "./picture-viewer.ts";
import type { VideoWindow } from "./video-fanout.ts";
import type { LinkRateLimits } from "./link-rate.ts";

export { PictureViewer, pictureKeyframeGapMs, type CapturedPicture } from "./picture-viewer.ts";
export { LinkFollow, linkCapped, pictureLinkLimits } from "./link-follow.ts";

/**
 * A screenshot is refused rather than queued while the transport holds more than this: control
 * messages on the same channel must never find it backed up (the relay closes a channel whose
 * control replies can't get out).
 */
export const pictureBacklogBytes = 128 * 1024;
/**
 * Live pictures wait while the transport holds more than this: about half a second of 8 Mbit/s
 * device video, room for a phone link's round trip, far below where control replies suffer.
 */
export const liveBacklogBytes = 512 * 1024;
/** Whole pictures queued or being written before a live one waits for the transport. */
const livePending = 4;
/** Whole pictures (live or still) the writer holds at most. */
const queueLimit = 8;

/** The binary half of one authenticated connection: stream pieces out, its backlog in. */
export interface PictureTransport {
  write(piece: Uint8Array): Promise<void>;
  bufferedBytes(): number;
}

export interface PictureChannelPorts {
  transport: PictureTransport;
  now(): number;
  after(ms: number, run: () => void): () => void;
  /** A write or its access check failed: the connection can't carry pictures any more. */
  failed(error: unknown): void;
  window?: VideoWindow;
}

/** One source's live view on this connection. */
export interface PictureView {
  push(picture: CapturedPicture): void;
  /** Bits per second this viewer's link carries now, when the view follows it (`link`). */
  rate(): number | undefined;
  close(): void;
}

/**
 * The pictures one connection carries for one picture kind (devices, or computer-use sessions):
 * a paced `PictureViewer` per source it watches and one-shot screenshots, written whole and in
 * order so pieces of two pictures never interleave. Each write first runs the view's access
 * check; a failed check or write ends the connection's pictures (`failed`).
 */
export class PictureChannel {
  readonly #kind: PictureKind;
  readonly #ports: PictureChannelPorts;
  readonly #viewers = new Map<string, PictureViewer>();
  #tail: Promise<void> = Promise.resolve();
  #queued = 0;
  #messageIds = 0;
  #retry: (() => void) | undefined;
  #closed = false;
  constructor(kind: PictureKind, ports: PictureChannelPorts) {
    this.#kind = kind;
    this.#ports = ports;
  }
  /**
   * Show `sourceId`'s live pictures, replacing any earlier view of it on this connection.
   * `keyframe` asks the capture for one; `guard` throws once the connection may no longer see
   * the source.
   */
  open(
    sourceId: string,
    options: { keyframe(): void; guard(): void; link?: LinkRateLimits },
  ): PictureView {
    if (this.#closed) throw new Error("Picture channel closed");
    this.#viewers.get(sourceId)?.close();
    const viewer = new PictureViewer(this.#kind, sourceId, {
      messageId: () => this.#nextId(),
      now: this.#ports.now,
      after: this.#ports.after,
      keyframe: options.keyframe,
      ...(this.#ports.window ? { window: this.#ports.window } : {}),
      ...(options.link ? { link: options.link } : {}),
      write: (pieces) => this.#writeLive(pieces, options.guard),
    });
    this.#viewers.set(sourceId, viewer);
    return {
      push: (picture) => viewer.push(picture),
      rate: () => viewer.rate,
      close: () => {
        viewer.close();
        if (this.#viewers.get(sourceId) === viewer) this.#viewers.delete(sourceId);
      },
    };
  }
  /** A viewer's ack: frees its window, or asks for a keyframe. Stale acks change nothing. */
  ack(sourceId: string, streamId: string, sequence: number, keyframe = false): void {
    this.#viewers.get(sourceId)?.ack(streamId, sequence, keyframe);
  }
  /**
   * One screenshot as a still picture, resolved once its pieces are written. A backed-up
   * connection refuses it rather than queue it behind the live view.
   */
  still(sourceId: string, picture: CapturedPicture, guard: () => void): Promise<void> {
    if (this.#ports.transport.bufferedBytes() > pictureBacklogBytes)
      return Promise.reject(
        new Error("Screenshot delivery congested; retry when the connection recovers"),
      );
    const { bytes, codecNamed: _named, ...header } = picture;
    const pieces = encodePicture(
      this.#kind,
      this.#nextId(),
      sourceId,
      { ...header, still: true },
      bytes,
    );
    return this.#run(pieces, guard);
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#retry?.();
    this.#retry = undefined;
    for (const viewer of this.#viewers.values()) viewer.close();
    this.#viewers.clear();
  }
  #nextId(): number {
    this.#messageIds = (this.#messageIds + 1) >>> 0;
    return this.#messageIds;
  }
  #writeLive(pieces: Uint8Array[], guard: () => void): boolean {
    if (
      this.#closed ||
      this.#queued >= livePending ||
      this.#ports.transport.bufferedBytes() > liveBacklogBytes
    ) {
      // The socket drains on its own; look again shortly unless a write will report it.
      if (!this.#queued && !this.#retry && !this.#closed)
        this.#retry = this.#ports.after(50, () => {
          this.#retry = undefined;
          this.#flush();
        });
      return false;
    }
    void this.#run(pieces, guard).then(
      () => this.#flush(),
      (error: unknown) => this.#ports.failed(error),
    );
    return true;
  }
  #flush(): void {
    for (const viewer of this.#viewers.values()) viewer.flush();
  }
  /** One whole picture's writes, in order with every other picture. */
  #run(pieces: Uint8Array[], guard: () => void): Promise<void> {
    if (this.#closed || this.#queued >= queueLimit)
      return Promise.reject(new Error("Picture writer unavailable or full"));
    this.#queued++;
    const next = this.#tail
      .then(async () => {
        if (this.#closed) throw new Error("Picture channel closed");
        guard();
        for (const piece of pieces) await this.#ports.transport.write(piece);
      })
      .finally(() => {
        this.#queued--;
      });
    this.#tail = next.catch(() => {});
    return next;
  }
}
