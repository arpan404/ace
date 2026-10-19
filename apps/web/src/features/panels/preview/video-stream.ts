import type { StreamMessage } from "@ace/client";
import type { DecodedPicture, VideoDecoderConfig, VideoDecoderFactory } from "./video-codecs.ts";

/** One encoded chunk of a thread's video, as the daemon's stream message carries it. */
export type BrowserVideoChunk = Extract<StreamMessage, { kind: "browser.video" }>["chunk"];

/** A decoded picture with the chunk's sizes: CSS pixels for input, coded for the bitmap. */
export interface VideoPicture {
  picture: DecodedPicture;
  width: number;
  height: number;
  codedWidth: number;
  codedHeight: number;
}

export interface VideoStreamHandlers {
  /** A picture to show; it is the receiver's to close. */
  present(picture: VideoPicture): void;
  /** Free the daemon's window up to `sequence`; `keyframe`: the decoder needs a fresh start. */
  ack(sequence: number, keyframe?: boolean): void;
}

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array | undefined) =>
  a === b ||
  (a !== undefined && b !== undefined && a.length === b.length && a.every((x, i) => x === b[i]));

const sameConfig = (a: VideoDecoderConfig | undefined, b: VideoDecoderConfig) =>
  a !== undefined &&
  a.codec === b.codec &&
  a.codedWidth === b.codedWidth &&
  a.codedHeight === b.codedHeight &&
  sameBytes(a.description, b.description);

type Sizes = Omit<VideoPicture, "picture">;

/**
 * One thread's video: chunks in, pictures out (ADR 0088). A keyframe configures the decoder
 * (again, when its codec, size or description changed); deltas before a keyframe can't be
 * decoded, so they are skipped and acked at once. A decode error drops the decoder, asks the
 * daemon for a keyframe, and skips deltas until one arrives.
 */
export class VideoStream {
  #factory: VideoDecoderFactory;
  #handlers: VideoStreamHandlers;
  #decoder: ReturnType<VideoDecoderFactory> | undefined;
  #config: VideoDecoderConfig | undefined;
  /** Sizes of chunks in the decoder, by sequence, so each picture knows its own. */
  #pending = new Map<number, Sizes>();
  #latest = -1;
  #closed = false;
  constructor(factory: VideoDecoderFactory, handlers: VideoStreamHandlers) {
    this.#factory = factory;
    this.#handlers = handlers;
  }
  receive(chunk: BrowserVideoChunk): void {
    if (this.#closed) return;
    this.#latest = Math.max(this.#latest, chunk.sequence);
    if (chunk.key) {
      const config: VideoDecoderConfig = {
        codec: chunk.codec,
        codedWidth: chunk.codedWidth,
        codedHeight: chunk.codedHeight,
        ...(chunk.description ? { description: chunk.description } : {}),
      };
      if (!this.#decoder || !sameConfig(this.#config, config)) {
        try {
          this.#decoder ??= this.#create();
          this.#decoder.configure(config);
          this.#config = config;
        } catch {
          this.#failed();
          return;
        }
      }
    } else if (!this.#decoder || !this.#config) {
      // Nothing to decode it against: the next keyframe starts the picture again.
      this.#handlers.ack(chunk.sequence);
      return;
    }
    this.#pending.set(chunk.sequence, {
      width: chunk.width,
      height: chunk.height,
      codedWidth: chunk.codedWidth,
      codedHeight: chunk.codedHeight,
    });
    try {
      this.#decoder?.decode({ key: chunk.key, sequence: chunk.sequence, bytes: chunk.bytes });
    } catch {
      this.#failed();
    }
  }
  /** Forget the decoder's place (a new subscription, a tab switch): wait for a keyframe. */
  reset(): void {
    this.#decoder?.close();
    this.#decoder = undefined;
    this.#config = undefined;
    this.#pending.clear();
    this.#latest = -1;
  }
  close(): void {
    this.reset();
    this.#closed = true;
  }
  #create() {
    const decoder = this.#factory({
      output: (picture) => {
        const sizes = this.#pending.get(picture.sequence);
        // A picture from a decoder that was dropped, or for a chunk it never had.
        if (this.#decoder !== decoder || !sizes || this.#closed) return picture.close();
        for (const sequence of this.#pending.keys())
          if (sequence <= picture.sequence) this.#pending.delete(sequence);
        this.#handlers.present({ picture, ...sizes });
      },
      error: () => {
        if (this.#decoder === decoder) this.#failed();
      },
    });
    return decoder;
  }
  #failed(): void {
    const latest = this.#latest;
    this.reset();
    this.#latest = latest;
    if (latest >= 0) this.#handlers.ack(latest, true);
  }
}
