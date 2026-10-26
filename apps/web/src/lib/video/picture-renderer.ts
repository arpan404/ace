import type { DecodedPicture, VideoDecoderFactory } from "./codecs.ts";
import { VideoStream } from "./stream.ts";

/** Something drawable for one picture, freed once drawn. */
export interface PictureImage {
  draw(context: CanvasRenderingContext2D, width: number, height: number): void;
  close(): void;
}

/**
 * One live picture as a picture kind carries it (a device's, or a computer-use session's): a
 * one H.264 access unit with its parameter sets in front of every keyframe.
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
  /** WebCodecs, or undefined where there is none (the view then says it can't show video). */
  decoder: VideoDecoderFactory | undefined;
  /** Show this picture; the image is the renderer's to close after. */
  show(image: PictureImage, picture: P): void;
  /** Tell the daemon the view showed `picture`; `keyframe`: the decoder lost its place. */
  ack(picture: P, keyframe: boolean): void;
  /** This client can't decode the stream's video: the view says so. Live views are video only. */
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
/** Pictures in the decoder whose details are kept for its output: about a second at 60 fps. */
const submittedLimit = 64;

/**
 * A source's live pictures onto its view (devices and computer use; ADR 0011 "One media
 * pipeline", ADR 0064 "Shared media stream"): H.264 only, through the same `VideoStream` the
 * browser's live view decodes with. Every picture is acked once shown (once
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
  /**
   * Pictures handed to the current decoder, by sequence, so a picture it hands back late is
   * shown with its own time, size and rotation rather than the newest picture's.
   */
  const submitted = new Map<number, P>();
  const submit = (picture: P) => {
    submitted.set(picture.sequence, picture);
    if (submitted.size <= submittedLimit) return;
    const oldest = submitted.keys().next();
    if (!oldest.done) submitted.delete(oldest.value);
  };
  /** The picture `sequence` came from; older ones are done with. */
  const take = (sequence: number): P | undefined => {
    const found = submitted.get(sequence);
    for (const key of submitted.keys()) {
      if (key > sequence) break;
      submitted.delete(key);
    }
    return found;
  };
  const forget = () => submitted.clear();
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
        const shown = take(picture.sequence);
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
        const target = submitted.get(sequence) ?? (latest && { ...latest, sequence });
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
    forget();
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
      // Live views are video only: a still that reaches one is acked and never drawn.
      if (picture.codec === "jpeg") return void ack(picture, false);
      const decoder = unsupported ? undefined : toVideo();
      if (!decoder) {
        giveUp(picture);
        return;
      }
      if (!picture.key && (needKey || gap)) {
        // Ask once, and again only if a second's worth of deltas passed without the keyframe.
        if (!asked || asked++ >= 30) {
          decoder.reset();
          forget();
          recover(picture);
        } else ack(picture, false);
        return;
      }
      needKey = false;
      asked = 0;
      latest = picture;
      submit(picture);
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
