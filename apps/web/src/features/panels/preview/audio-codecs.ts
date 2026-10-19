/*
 * The platform boundary for the browser's page sound (ADR 0088, Audio): a WebCodecs Opus
 * decoder and a Web Audio output. Everything else takes these as injected functions, so tests
 * run without either.
 */

/** Decoded samples: copyable until closed. */
export interface DecodedSound {
  /** Stream ms when the sound was captured (the chunk's `timestamp`). */
  readonly timestamp: number;
  readonly frames: number;
  readonly sampleRate: number;
  readonly channels: number;
  copy(channel: number, into: Float32Array): void;
  close(): void;
}

export interface AudioDecoderConfig {
  codec: string;
  sampleRate: number;
  channels: number;
}

/** One decoder instance. A call that throws counts as a decode error. */
export interface AudioDecoding {
  configure(config: AudioDecoderConfig): void;
  decode(chunk: { timestamp: number; bytes: Uint8Array }): void;
  close(): void;
}

export type AudioDecoderFactory = (handlers: {
  output(sound: DecodedSound): void;
  error(): void;
}) => AudioDecoding;

/** The speaker: plays decoded sound at a local time (ms, `performance.now()`'s clock). */
export interface AudioOutput {
  play(sound: DecodedSound, at: number): void;
  close(): void;
}

/**
 * Opens the speaker. Call it inside the person's click or tap: phone browsers only start sound
 * from a user gesture.
 */
export type AudioOutputFactory = () => AudioOutput;

/** The platform's Opus decoder, or undefined where WebCodecs has no `AudioDecoder`. */
export function webCodecsAudioDecoder(): AudioDecoderFactory | undefined {
  if (
    typeof globalThis.AudioDecoder !== "function" ||
    typeof globalThis.EncodedAudioChunk !== "function"
  )
    return undefined;
  const Decoder = globalThis.AudioDecoder;
  return (handlers) => {
    const decoder = new Decoder({
      output: (data) =>
        handlers.output({
          // Decoded with µs timestamps: back to the stream's ms.
          timestamp: data.timestamp / 1000,
          frames: data.numberOfFrames,
          sampleRate: data.sampleRate,
          channels: data.numberOfChannels,
          copy: (channel, into) => data.copyTo(into, { planeIndex: channel, format: "f32-planar" }),
          close: () => data.close(),
        }),
      error: () => handlers.error(),
    });
    return {
      configure: (config) =>
        decoder.configure({
          codec: config.codec,
          sampleRate: config.sampleRate,
          numberOfChannels: config.channels,
        }),
      decode: (chunk) =>
        decoder.decode(
          new EncodedAudioChunk({
            type: "key",
            timestamp: Math.round(chunk.timestamp * 1000),
            data: chunk.bytes,
          }),
        ),
      close: () => {
        if (decoder.state !== "closed") decoder.close();
      },
    };
  };
}

/** Web Audio as the speaker, or undefined where there is none. */
export function webAudioOutput(now: () => number): AudioOutputFactory | undefined {
  if (typeof globalThis.AudioContext !== "function") return undefined;
  const Context = globalThis.AudioContext;
  return () => {
    const context = new Context({ latencyHint: "interactive" });
    // Inside the person's gesture, this is what lets a phone play.
    void context.resume().catch(() => {});
    return {
      play(sound, at) {
        try {
          if (context.state === "closed") return;
          const buffer = context.createBuffer(sound.channels, sound.frames, sound.sampleRate);
          const samples = new Float32Array(sound.frames);
          for (let channel = 0; channel < sound.channels; channel++) {
            sound.copy(channel, samples);
            buffer.copyToChannel(samples, channel);
          }
          const source = context.createBufferSource();
          source.buffer = buffer;
          source.connect(context.destination);
          source.start(Math.max(context.currentTime, contextTime(context, at, now)));
        } catch {
          // A sound that can't be played is skipped; the next one may.
        } finally {
          sound.close();
        }
      },
      close() {
        void context.close().catch(() => {});
      },
    };
  };
}

/** The context time heard at local time `at`, through the device's output latency. */
function contextTime(context: AudioContext, at: number, now: () => number): number {
  const stamp =
    typeof context.getOutputTimestamp === "function" ? context.getOutputTimestamp() : {};
  if (stamp.contextTime !== undefined && stamp.performanceTime)
    return stamp.contextTime + (at - stamp.performanceTime) / 1000;
  return context.currentTime + (at - now()) / 1000 - (context.outputLatency || context.baseLatency);
}
