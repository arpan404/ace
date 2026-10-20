import { EncodePacer, EncoderWatchdog } from "../src/video-pacing.ts";
import { TabAudio } from "./audio.ts";

/*
 * The video extension's offscreen document (ADR 0088): opens a tab capture and encodes it with
 * WebCodecs, once per encode the daemon asks for, and its sound as Opus while asked (`audio.ts`).
 * The daemon drives it over CDP (`Runtime.evaluate` on this document) and receives every chunk
 * through the CDP binding `aceVideoEvent`: a JSON line, then for a chunk its bytes in base64.
 * Every chunk says how long ago (`age`, ms) its picture or sound was captured, so the daemon
 * stamps video and audio on one clock.
 */

interface EncodeSpec {
  key: string;
  codec: string;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
}

interface FrameReader {
  read(): Promise<{ done: boolean; value?: VideoFrame }>;
  cancel(): Promise<void>;
}
interface TrackProcessor {
  readonly readable: { getReader(): FrameReader };
}
declare const MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => TrackProcessor;

interface Encoder {
  spec: EncodeSpec;
  encoder: VideoEncoder | undefined;
  pacer: EncodePacer;
  watchdog: EncoderWatchdog;
  /** Configurations still to try, best first: hardware, then software. */
  configs: VideoEncoderConfig[];
  /** The configuration the running encoder took. */
  active: VideoEncoderConfig | undefined;
  description: string | undefined;
  /** Bumped per configuration: output from a replaced encoder is ignored. */
  generation: number;
}

interface Capture {
  id: string;
  /** A tab capture's track and its frames; absent for a capture fed pushed pictures. */
  track: MediaStreamTrack | undefined;
  reader: FrameReader | undefined;
  /** Pushed pictures: one decodes at a time, and only the newest waiting one is kept. */
  decoding: boolean;
  waiting: Uint8Array<ArrayBuffer> | undefined;
  last: VideoFrame | undefined;
  lastAt: number;
  encoders: Map<string, Encoder>;
  /** The tab's sound; absent when the capture has no audio track. */
  audio: TabAudio | undefined;
  stopped: boolean;
}

const captures = new Map<string, Capture>();
const now = () => performance.now();

function emit(event: Record<string, unknown>, bytes?: Uint8Array): void {
  const send: unknown = Reflect.get(globalThis, "aceVideoEvent");
  if (typeof send !== "function") return;
  const line = JSON.stringify(event);
  Reflect.apply(send, globalThis, [bytes ? `${line}\n${base64(bytes)}` : line]);
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function configsFor(spec: EncodeSpec): VideoEncoderConfig[] {
  const base: VideoEncoderConfig = {
    codec: spec.codec,
    width: spec.width,
    height: spec.height,
    bitrate: spec.bitrate,
    framerate: spec.fps,
    latencyMode: "realtime",
    bitrateMode: "variable",
    ...(spec.codec.startsWith("avc1.") ? { avc: { format: "avc" } } : {}),
  };
  return [
    { ...base, hardwareAcceleration: "prefer-hardware" },
    { ...base, hardwareAcceleration: "prefer-software" },
  ];
}

/** The next configuration this encode can run with; none left reports it failed. */
async function configure(capture: Capture, entry: Encoder, reason: string): Promise<void> {
  if (entry.encoder && entry.encoder.state !== "closed") entry.encoder.close();
  entry.encoder = undefined;
  const generation = ++entry.generation;
  for (let config = entry.configs.shift(); config; config = entry.configs.shift()) {
    const support = await VideoEncoder.isConfigSupported(config).catch(() => undefined);
    if (generation !== entry.generation || capture.encoders.get(entry.spec.key) !== entry) return;
    if (!support?.supported) continue;
    const encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        if (generation !== entry.generation) return;
        entry.watchdog.output();
        const description = metadata?.decoderConfig?.description;
        if (description)
          entry.description = base64(
            ArrayBuffer.isView(description)
              ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
              : new Uint8Array(description),
          );
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        const key = chunk.type === "key";
        emit(
          {
            t: "chunk",
            capture: capture.id,
            encode: entry.spec.key,
            key,
            codec: entry.spec.codec,
            codedWidth: metadata?.decoderConfig?.codedWidth ?? entry.spec.width,
            codedHeight: metadata?.decoderConfig?.codedHeight ?? entry.spec.height,
            // Frames are stamped with `now()` as they go in (`encode`).
            age: Math.max(0, now() - chunk.timestamp / 1000),
            ...(key && entry.description ? { description: entry.description } : {}),
          },
          bytes,
        );
      },
      error: (error) => {
        if (generation !== entry.generation) return;
        void configure(capture, entry, String(error));
      },
    });
    encoder.configure(config);
    entry.active = config;
    entry.encoder = encoder;
    entry.watchdog = new EncoderWatchdog();
    entry.pacer.requestKeyframe();
    return;
  }
  emit({ t: "failed", capture: capture.id, encode: entry.spec.key, reason });
}

/** A running encode's new bit rate: the encoder reconfigures in place, keeping its stream. */
function retune(entry: Encoder, bitrate: number): void {
  if (entry.spec.bitrate === bitrate) return;
  entry.spec = { ...entry.spec, bitrate };
  // Configurations not tried yet take the new rate too.
  entry.configs = entry.configs.map((config) => ({ ...config, bitrate }));
  const encoder = entry.encoder;
  if (!encoder || encoder.state !== "configured" || !entry.active) return;
  entry.active = { ...entry.active, bitrate };
  try {
    encoder.configure(entry.active);
  } catch {
    // An encoder that refuses a new rate keeps its old one.
  }
}

function encode(entry: Encoder, frame: VideoFrame, key: boolean): void {
  const encoder = entry.encoder;
  if (!encoder || encoder.state !== "configured") return;
  // Our own clock: a still frame encoded again needs a later timestamp than last time.
  const stamped = new VideoFrame(frame, { timestamp: Math.round(now() * 1000) });
  try {
    encoder.encode(stamped, { keyFrame: key });
    entry.watchdog.submitted(now());
  } finally {
    stamped.close();
  }
}

const busy = (entry: Encoder) => (entry.encoder?.encodeQueueSize ?? 0) > 2;

/** A new captured frame: each encode takes it as its pacer says. The capture keeps it. */
function feed(capture: Capture, frame: VideoFrame): void {
  capture.last?.close();
  capture.last = frame;
  capture.lastAt = now();
  for (const entry of capture.encoders.values()) {
    const decision = entry.pacer.frame(capture.lastAt, busy(entry));
    if (decision !== "skip") encode(entry, frame, decision === "key");
  }
}

async function pump(capture: Capture): Promise<void> {
  const reader = capture.reader;
  if (!reader) return;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    if (capture.stopped) {
      value.close();
      break;
    }
    feed(capture, value);
  }
  if (!capture.stopped) {
    stop(capture.id);
    emit({ t: "ended", capture: capture.id });
  }
}

function stop(id: string): void {
  const capture = captures.get(id);
  if (!capture) return;
  captures.delete(id);
  capture.stopped = true;
  for (const entry of capture.encoders.values()) {
    entry.generation++;
    if (entry.encoder?.state !== "closed") entry.encoder?.close();
  }
  capture.encoders.clear();
  void capture.reader?.cancel().catch(() => {});
  capture.track?.stop();
  capture.waiting = undefined;
  capture.audio?.stop();
  capture.last?.close();
  capture.last = undefined;
}

/** Decodes a pushed-picture capture's newest waiting picture until none waits. */
async function decodePictures(capture: Capture): Promise<void> {
  capture.decoding = true;
  try {
    for (let bytes = capture.waiting; bytes && !capture.stopped; bytes = capture.waiting) {
      capture.waiting = undefined;
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" })).catch(
        () => undefined,
      );
      if (!bitmap) continue;
      if (capture.stopped) {
        bitmap.close();
        break;
      }
      const frame = new VideoFrame(bitmap, { timestamp: Math.round(now() * 1000) });
      bitmap.close();
      feed(capture, frame);
    }
  } finally {
    capture.decoding = false;
  }
}

// Owed keyframes on a still page, and encoders that stopped answering.
setInterval(() => {
  const at = now();
  for (const capture of captures.values())
    for (const entry of capture.encoders.values()) {
      if (entry.watchdog.stalled(at)) {
        void configure(capture, entry, "The encoder stopped producing output");
        continue;
      }
      if (capture.last && entry.pacer.still(at, capture.lastAt, busy(entry)))
        encode(entry, capture.last, true);
    }
}, 50);

Object.assign(globalThis, {
  aceVideo: {
    /** The codecs this browser encodes at this size, in the order asked. */
    async supported(codecs: readonly string[], width: number, height: number) {
      const supported: string[] = [];
      for (const codec of codecs) {
        const configs = configsFor({ key: "", codec, width, height, fps: 60, bitrate: 6e6 });
        for (const config of configs) {
          const result = await VideoEncoder.isConfigSupported(config).catch(() => undefined);
          if (result?.supported) {
            supported.push(codec);
            break;
          }
        }
      }
      return supported;
    },
    /** Opens the tab capture `streamId` at exactly this size, replacing capture `id`. */
    async start(id: string, streamId: string, width: number, height: number): Promise<void> {
      stop(id);
      const video = {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
          minWidth: width,
          maxWidth: width,
          minHeight: height,
          maxHeight: height,
          maxFrameRate: 60,
        },
      };
      // The tab's sound rides the same capture (ADR 0088, Audio); a capture that can't take it
      // still streams its picture.
      const capture = (audio: boolean): Promise<unknown> =>
        Reflect.apply(navigator.mediaDevices.getUserMedia, navigator.mediaDevices, [
          {
            audio: audio
              ? { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } }
              : false,
            video,
          },
        ]);
      const stream: unknown = await capture(true).catch(() => capture(false));
      if (!(stream instanceof MediaStream)) throw new Error("No tab capture");
      const [track] = stream.getVideoTracks();
      if (!track) throw new Error("No tab capture");
      const [sound] = stream.getAudioTracks();
      const opened: Capture = {
        id,
        track,
        reader: new MediaStreamTrackProcessor({ track }).readable.getReader(),
        decoding: false,
        waiting: undefined,
        last: undefined,
        lastAt: 0,
        encoders: new Map(),
        audio: sound
          ? new TabAudio(sound, (event, bytes) => emit({ ...event, capture: id }, bytes), now)
          : undefined,
        stopped: false,
      };
      captures.set(id, opened);
      void pump(opened).catch((error: unknown) => {
        if (opened.stopped) return;
        stop(id);
        emit({ t: "ended", capture: id, reason: String(error) });
      });
    },
    /**
     * Opens capture `id` fed by pushed pictures (a page's JPEG screencast) instead of a tab
     * capture: for tabs this extension can't capture, such as a private browser context.
     */
    startPictures(id: string): void {
      stop(id);
      captures.set(id, {
        id,
        track: undefined,
        reader: undefined,
        decoding: false,
        waiting: undefined,
        last: undefined,
        lastAt: 0,
        encoders: new Map(),
        audio: undefined,
        stopped: false,
      });
    },
    /** One pushed picture (a base64 JPEG) for capture `id`. */
    picture(id: string, jpeg: string): void {
      const capture = captures.get(id);
      if (!capture || capture.track) return;
      capture.waiting = Uint8Array.from(atob(jpeg), (char) => char.charCodeAt(0));
      if (!capture.decoding) void decodePictures(capture);
    },
    /**
     * The encodes capture `id` runs: new ones start (at a keyframe), missing ones stop, and a
     * running one given another bit rate takes it in place, without a keyframe.
     */
    encodes(id: string, specs: readonly EncodeSpec[]): void {
      const capture = captures.get(id);
      if (!capture) return;
      const wanted = new Set(specs.map((spec) => spec.key));
      for (const [key, entry] of capture.encoders)
        if (!wanted.has(key)) {
          entry.generation++;
          if (entry.encoder?.state !== "closed") entry.encoder?.close();
          capture.encoders.delete(key);
        }
      for (const spec of specs) {
        const running = capture.encoders.get(spec.key);
        if (running) {
          retune(running, spec.bitrate);
          continue;
        }
        const entry: Encoder = {
          spec,
          encoder: undefined,
          pacer: new EncodePacer(spec.fps),
          watchdog: new EncoderWatchdog(),
          configs: configsFor(spec),
          active: undefined,
          description: undefined,
          generation: 0,
        };
        capture.encoders.set(spec.key, entry);
        void configure(capture, entry, "No encoder supports this codec here");
      }
    },
    /** Encode capture `id`'s sound too, or stop; it starts off. */
    audio(id: string, on: boolean): void {
      captures.get(id)?.audio?.set(on);
    },
    keyframe(id: string, key: string): void {
      captures.get(id)?.encoders.get(key)?.pacer.requestKeyframe();
    },
    stop,
  },
});
