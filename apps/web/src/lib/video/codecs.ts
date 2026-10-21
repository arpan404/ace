/** Runs `callback` after `ms`; the result cancels it. */
type Schedule = (callback: () => void, ms: number) => () => void;

/*
 * The WebCodecs boundary for live video (ADR 0088): the browser's view and device screens.
 * Which codecs this client can decode, and a decoder that hands back pictures to draw.
 * Everything else in the video path takes these as injected functions, so tests run without
 * WebCodecs.
 */

/**
 * Codecs the daemon may encode, in the order this client prefers them: HEVC first (Apple
 * hardware encodes it, and it needs roughly half H.264's bits for the same picture), then
 * H.264 High, then Baseline. A browser lists only those its decoder takes.
 */
export const videoCandidates = [
  "hvc1.1.6.L153.B0",
  "avc1.640033",
  "avc1.42E033",
  "vp09.00.41.08",
  "vp8",
] as const;

/** Which candidates this client decodes, best first; empty without WebCodecs. */
export type VideoSupport = () => Promise<readonly string[]>;

/** A decoded picture: drawable until closed. `sequence` is the chunk's it came from. */
export interface DecodedPicture {
  readonly sequence: number;
  draw(context: CanvasRenderingContext2D, width: number, height: number): void;
  close(): void;
}

export interface VideoDecoderConfig {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  description?: Uint8Array | undefined;
}

/** One decoder instance. A call that throws counts as a decode error. */
export interface VideoDecoding {
  configure(config: VideoDecoderConfig): void;
  decode(chunk: { key: boolean; sequence: number; bytes: Uint8Array }): void;
  close(): void;
}

export type VideoDecoderFactory = (handlers: {
  output(picture: DecodedPicture): void;
  /** `unsupported`: the platform can't decode this stream at all (WebCodecs' NotSupportedError). */
  error(unsupported?: boolean): void;
}) => VideoDecoding;

/** Whether this platform has WebCodecs decoding at all. */
const decoderClass = (): typeof VideoDecoder | undefined =>
  typeof globalThis.VideoDecoder === "function" &&
  typeof globalThis.EncodedVideoChunk === "function"
    ? globalThis.VideoDecoder
    : undefined;

/** Asks the platform's `VideoDecoder` about each candidate; a probe that hangs gives up. */
export const webCodecsSupport: VideoSupport = async () => {
  const Decoder = decoderClass();
  if (!Decoder || typeof Decoder.isConfigSupported !== "function") return [];
  const answers = await Promise.all(
    videoCandidates.map((codec) =>
      Decoder.isConfigSupported({ codec }).then(
        (result) => result.supported === true,
        () => false,
      ),
    ),
  );
  return videoCandidates.filter((_, index) => answers[index]);
};

/**
 * Which decoder a stream runs on, as far as this page can tell: `hardware` asked WebCodecs to
 * prefer hardware and it took the configuration; `default` is the browser's own choice after
 * that failed. WebCodecs never says whether a decode actually ran in hardware.
 */
export type DecoderPreference = "hardware" | "default";

/**
 * The platform's `VideoDecoder`, or undefined where there is none (issue #1187). Each decoder
 * asks for hardware first. A configuration the hint breaks (refused at once, or failing before
 * its first picture) falls back to the browser's default once for this factory, never back and
 * forth; only a failure without the hint counts as a codec this platform can't decode.
 */
export function webCodecsDecoder(
  onPreference?: (preference: DecoderPreference, reason?: string) => void,
): VideoDecoderFactory | undefined {
  const Decoder = decoderClass();
  if (!Decoder) return undefined;
  let hardware = true;
  const fallBack = (reason: string) => {
    if (!hardware) return;
    hardware = false;
    onPreference?.("default", reason);
  };
  return (handlers) => {
    let preferred = false;
    let pictured = false;
    const decoder = new Decoder({
      output: (frame) => {
        pictured = true;
        handlers.output({
          sequence: frame.timestamp,
          draw: (context, width, height) => context.drawImage(frame, 0, 0, width, height),
          close: () => frame.close(),
        });
      },
      error: (failure) => {
        // The hint broke this stream: the next keyframe starts a decoder without it.
        if (preferred && !pictured) {
          fallBack(failure.name);
          return handlers.error(false);
        }
        handlers.error(failure.name === "NotSupportedError");
      },
    });
    return {
      configure: (config) => {
        const base = {
          codec: config.codec,
          codedWidth: config.codedWidth,
          codedHeight: config.codedHeight,
          optimizeForLatency: true,
          ...(config.description ? { description: config.description } : {}),
        };
        if (hardware) {
          try {
            decoder.configure({ ...base, hardwareAcceleration: "prefer-hardware" });
            preferred = true;
            onPreference?.("hardware");
            return;
          } catch (error) {
            fallBack(error instanceof Error ? error.name : "TypeError");
          }
        }
        preferred = false;
        decoder.configure(base);
      },
      decode: (chunk) =>
        decoder.decode(
          new EncodedVideoChunk({
            type: chunk.key ? "key" : "delta",
            // The sequence rides as the timestamp, so the decoded frame says which chunk it is.
            timestamp: chunk.sequence,
            data: chunk.bytes,
          }),
        ),
      close: () => {
        if (decoder.state !== "closed") decoder.close();
      },
    };
  };
}

/** Resolves to `fallback` if `promise` hasn't settled within `ms`. */
export function within<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
  later: Schedule,
): Promise<T> {
  return new Promise((resolve) => {
    const cancel = later(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        cancel();
        resolve(value);
      },
      () => {
        cancel();
        resolve(fallback);
      },
    );
  });
}
