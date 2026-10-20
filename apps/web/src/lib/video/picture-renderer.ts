import type { DecodedPicture, VideoDecoderFactory } from "./codecs.ts";
import { VideoStream } from "./stream.ts";

/** Something drawable for one picture, freed once drawn. */
export interface PictureImage {
  draw(context: CanvasRenderingContext2D, width: number, height: number): void;
  close(): void;
}

/**
 * One live picture as a picture kind carries it (a device's, or a computer-use session's): a
 * JPEG, or one H.264 access unit with its parameter sets in front of every keyframe.
 */
export interface LivePicture {
  streamId: string;
  sequence: number;
  timestamp: number;
  width: number;
  height: number;
  codec: string;
  key: boolean;
  bytes: Uint8Array;
}

export interface PictureRendererPorts<P extends LivePicture> {
  /** WebCodecs, or undefined where there is none (every picture must be JPEG then). */
  decoder: VideoDecoderFactory | undefined;
  /**
   * A JPEG's bytes as something drawable. Absent for a view that takes video only (a device's
   * live view): a JPEG is then acked and never drawn.
   */
  image?(bytes: Uint8Array): Promise<PictureImage>;
  /** Show this picture; the image is the renderer's to close after. */
  show(image: PictureImage, picture: P): void;
  /** Tell the daemon the view showed `picture`; `keyframe`: the decoder lost its place. */
  ack(picture: P, keyframe: boolean): void;
  /** This client can't decode the stream's video: ask for JPEG instead, or say so (video only). */
  fallback(): void;
  /** The view fell behind or lost pictures: a lighter stream may keep up. */
  pressure(): void;
  /**
   * Runs `draw` at the display's next refresh (`requestAnimationFrame`); the result cancels it.
   * Given, decoded video is acked at once and only the newest picture is drawn at each refresh,
   * so a burst after a stall jumps to the present instead of replaying it. Absent, each picture
   * is drawn as it decodes.
   */
  nextFrame?(draw: () => void): () => void;
}

/** Decoder errors in a row without a picture before the codec counts as unsupported here. */
const failureLimit = 3;

/**
 * A source's live pictures onto its view (devices and computer use; ADR 0011 "One media
 * pipeline", ADR 0064 "Shared media stream"): JPEGs drawn as they come, H.264 through the same
 * `VideoStream` the browser's live view decodes with. Every picture is acked once shown (once
 * decoded, when drawing is paced to the display), or at once when it can't be shown, so the
 * daemon's window never waits on a picture this view dropped. A delta after a gap waits for a keyframe, which is asked for through the ack.
 */
export function pictureRenderer<P extends LivePicture>(ports: PictureRendererPorts<P>) {
  const ack = (picture: P, keyframe: boolean) => ports.ack(picture, keyframe);
  let stream: string | undefined;
  let previous = -1;
  let video: VideoStream | undefined;
  /** The newest H.264 picture handed to the decoder: acks name its stream. */
  let latest: P | undefined;
  /** Deltas can't be decoded until a keyframe comes; `asked`: one was asked for. */
  let needKey = true;
  let asked = 0;
  let failures = 0;
  let unsupported = false;
  /** The platform said it can't decode this stream at all: no point asking for a keyframe. */
  let refused = false;
  let closed = false;
  /** The newest decoded picture waiting for the display's next refresh. */
  let queued: { picture: DecodedPicture; shown: P } | undefined;
  let cancelFrame: (() => void) | undefined;
  const dropQueued = () => {
    cancelFrame?.();
    cancelFrame = undefined;
    queued?.picture.close();
    queued = undefined;
  };
  const drawQueued = () => {
    cancelFrame = undefined;
    const next = queued;
    queued = undefined;
    if (!next) return;
    try {
      if (!closed) ports.show(asImage(next.picture), next.shown);
    } finally {
      next.picture.close();
    }
  };

  const recover = (picture: P) => {
    needKey = true;
    asked = 1;
    ports.pressure();
    ack(picture, true);
  };
  const toVideo = (): VideoStream | undefined => {
    const factory = ports.decoder;
    if (video || !factory) return video;
    const decoder: VideoDecoderFactory = (handlers) =>
      factory({
        ...handlers,
        error: (unsupportedCodec) => {
          if (unsupportedCodec) refused = true;
          handlers.error(unsupportedCodec);
        },
      });
    video = new VideoStream(decoder, {
      present: ({ picture }) => {
        const shown = latest && { ...latest, sequence: picture.sequence };
        if (closed || !shown) return picture.close();
        failures = 0;
        const nextFrame = ports.nextFrame;
        if (nextFrame) {
          // Newest wins: a picture replaced before the refresh is freed undrawn, but acked.
          queued?.picture.close();
          queued = { picture, shown };
          cancelFrame ??= nextFrame(drawQueued);
          ack(shown, false);
          return;
        }
        try {
          ports.show(asImage(picture), shown);
        } finally {
          picture.close();
        }
        ack(shown, false);
      },
      ack: (sequence, keyframe) => {
        const target = latest && { ...latest, sequence };
        if (!target) return;
        if (!keyframe) return void ack(target, false);
        // A decode error: the decoder starts again from a keyframe, or gives up on video.
        if (refused || ++failures >= failureLimit) giveUp(target);
        else recover(target);
      },
    });
    return video;
  };
  const giveUp = (picture: P) => {
    ack(picture, false);
    if (unsupported) return;
    unsupported = true;
    video?.close();
    video = undefined;
    ports.fallback();
  };
  const reset = () => {
    dropQueued();
    video?.reset();
    previous = -1;
    needKey = true;
    asked = 0;
  };

  return {
    async render(picture: P): Promise<void> {
      if (closed) return;
      if (picture.streamId !== stream) {
        // A new capture: its sequence starts over, and its first picture to show is a keyframe.
        stream = picture.streamId;
        reset();
        failures = 0;
        unsupported = false;
      }
      if (picture.sequence <= previous) return;
      const gap = previous >= 0 && picture.sequence !== previous + 1;
      previous = picture.sequence;
      if (picture.codec === "jpeg") {
        const decode = ports.image;
        if (!decode) return void ack(picture, false);
        video?.reset();
        let image: PictureImage | undefined;
        try {
          image = await decode(picture.bytes);
          if (!closed) ports.show(image, picture);
        } catch {
          // An undecodable JPEG is skipped; the next one replaces it.
        } finally {
          image?.close();
          ack(picture, false);
        }
        return;
      }
      const decoder = unsupported ? undefined : toVideo();
      if (!decoder) {
        giveUp(picture);
        return;
      }
      if (!picture.key && (needKey || gap)) {
        // Ask once, and again only if a second's worth of deltas passed without the keyframe.
        if (!asked || asked++ >= 30) {
          decoder.reset();
          recover(picture);
        } else ack(picture, false);
        return;
      }
      needKey = false;
      asked = 0;
      latest = picture;
      decoder.receive({ ...picture, codedWidth: picture.width, codedHeight: picture.height });
    },
    /** Forget the decoder's place (a hidden page, a reconnect): the next keyframe starts over. */
    reset,
    close() {
      closed = true;
      dropQueued();
      video?.close();
      video = undefined;
    },
  };
}

const asImage = (picture: DecodedPicture): PictureImage => ({
  draw: (context, width, height) => picture.draw(context, width, height),
  close: () => {},
});
