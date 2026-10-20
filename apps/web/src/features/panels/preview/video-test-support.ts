import type { VideoDecoderFactory, VideoSupport } from "@/lib/video/codecs.ts";

/** A decoded picture, remembering whether it was freed. */
export interface TrackedPicture {
  readonly sequence: number;
  closed: boolean;
}

/** One decoder instance: what it holds undecoded, and its failure. */
export interface TrackedDecoder {
  /** Chunks given but not out yet (a held decoder only). */
  readonly pending: number[];
  closed: boolean;
  /** Everything given so far comes out, in order. */
  flush(): void;
  /** The decoder reports a decode error. */
  fail(): void;
}

/** Plays the first codec it is offered, as a WebCodecs probe that supports H.264 does. */
export const playsH264: VideoSupport = () => Promise.resolve(["avc1.42E033"]);

function tracking(hold: boolean) {
  const pictures: TrackedPicture[] = [];
  const decoders: TrackedDecoder[] = [];
  const factory: VideoDecoderFactory = (handlers) => {
    const out = (sequence: number) => {
      const picture: TrackedPicture = { sequence, closed: false };
      pictures.push(picture);
      handlers.output({
        sequence,
        draw() {},
        close() {
          picture.closed = true;
        },
      });
    };
    const decoder: TrackedDecoder = {
      pending: [],
      closed: false,
      flush() {
        for (const sequence of decoder.pending.splice(0)) out(sequence);
      },
      fail: () => handlers.error(),
    };
    decoders.push(decoder);
    return {
      configure() {},
      decode(chunk) {
        if (hold) decoder.pending.push(chunk.sequence);
        else out(chunk.sequence);
      },
      close() {
        decoder.closed = true;
      },
    };
  };
  return { factory, pictures, decoders };
}

/**
 * A stand-in for the platform's video decoder, injected as `videoDecoder`: every chunk comes out
 * as a picture at once. Each picture remembers whether it was freed.
 */
export const instantDecoder = () => tracking(false);

/** Like `instantDecoder`, but each decoder holds its chunks until the test flushes it. */
export const heldDecoder = () => tracking(true);
