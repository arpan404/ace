import type { StreamMessage } from "@ace/client";
import type {
  AudioDecoderConfig,
  AudioDecoderFactory,
  AudioDecoding,
  AudioOutput,
  AudioOutputFactory,
} from "./audio-codecs.ts";
import { AvSync } from "./av-sync.ts";

/** One encoded chunk of a thread's page sound, as the daemon's stream message carries it. */
export type BrowserAudioChunk = Extract<StreamMessage, { kind: "browser.audio" }>["chunk"];

export interface ThreadAudioOptions {
  /** Absent: this client can't play page sound, and offers no speaker. */
  decoder: AudioDecoderFactory | undefined;
  output: AudioOutputFactory | undefined;
  /** Local time in ms, on the clock the output plays by (`performance.now()`). */
  now: () => number;
}

interface Listening {
  decoder: AudioDecoding | undefined;
  config: AudioDecoderConfig | undefined;
}

/**
 * Each thread's page sound (ADR 0088, Audio). Every thread starts muted; the person's speaker
 * toggle turns it on, and only then are chunks decoded and played, through one shared output
 * opened inside that click. Sound is scheduled against the thread's video (`AvSync`).
 */
export class ThreadAudio {
  #options: ThreadAudioOptions;
  #threads = new Map<string, Listening>();
  /** Each shown thread's video timing, kept while muted so unmuting starts in step. */
  #syncs = new Map<string, AvSync>();
  #output: AudioOutput | undefined;
  constructor(options: ThreadAudioOptions) {
    this.#options = options;
  }
  /** Whether this client can play page sound at all. */
  get available(): boolean {
    return this.#options.decoder !== undefined && this.#options.output !== undefined;
  }
  on(threadId: string): boolean {
    return this.#threads.has(threadId);
  }
  /** The person's speaker toggle. Turning it on must happen inside their click or tap. */
  set(threadId: string, on: boolean): void {
    if (!on) return this.#mute(threadId);
    const output = this.#options.output;
    if (!this.available || !output || this.#threads.has(threadId)) return;
    this.#output ??= output();
    this.#threads.set(threadId, { decoder: undefined, config: undefined });
  }
  receive(threadId: string, chunk: BrowserAudioChunk): void {
    const thread = this.#threads.get(threadId);
    const factory = this.#options.decoder;
    if (!thread || !factory) return;
    const config = { codec: chunk.codec, sampleRate: chunk.sampleRate, channels: chunk.channels };
    try {
      if (!thread.decoder || !sameConfig(thread.config, config)) {
        thread.decoder ??= this.#decoder(threadId, thread, factory);
        thread.decoder.configure(config);
        thread.config = config;
      }
      thread.decoder.decode({ timestamp: chunk.timestamp, bytes: chunk.bytes });
    } catch {
      this.#failed(thread);
    }
  }
  /** A picture captured at `timestamp` (stream ms) is on screen now. */
  shown(threadId: string, timestamp: number): void {
    if (!this.available) return;
    this.#sync(threadId).shown(timestamp, this.#options.now());
  }
  /** The thread's stream starts over (a new subscription, another tab). */
  reset(threadId: string): void {
    this.#syncs.get(threadId)?.reset();
    const thread = this.#threads.get(threadId);
    if (thread) this.#failed(thread);
  }
  /** The thread is gone from this client: muted, and its timing forgotten. */
  delete(threadId: string): void {
    this.#mute(threadId);
    this.#syncs.delete(threadId);
  }
  dispose(): void {
    for (const threadId of new Set([...this.#threads.keys(), ...this.#syncs.keys()]))
      this.delete(threadId);
  }
  #sync(threadId: string): AvSync {
    let sync = this.#syncs.get(threadId);
    if (!sync) {
      sync = new AvSync();
      this.#syncs.set(threadId, sync);
    }
    return sync;
  }
  /** Its decoder goes, and the output once nobody listens. */
  #mute(threadId: string): void {
    const thread = this.#threads.get(threadId);
    if (!thread) return;
    this.#threads.delete(threadId);
    this.#failed(thread);
    if (!this.#threads.size) {
      this.#output?.close();
      this.#output = undefined;
    }
  }
  #decoder(threadId: string, thread: Listening, factory: AudioDecoderFactory): AudioDecoding {
    const decoder = factory({
      output: (sound) => {
        const output = this.#output;
        if (this.#threads.get(threadId) !== thread || thread.decoder !== decoder || !output)
          return sound.close();
        const at = this.#sync(threadId).schedule(
          sound.timestamp,
          (sound.frames / sound.sampleRate) * 1000,
          this.#options.now(),
        );
        if (at === undefined) return sound.close();
        output.play(sound, at);
      },
      // Every Opus packet decodes on its own: the next chunk configures a fresh decoder.
      error: () => {
        if (thread.decoder === decoder) this.#failed(thread);
      },
    });
    return decoder;
  }
  #failed(thread: Listening): void {
    thread.decoder?.close();
    thread.decoder = undefined;
    thread.config = undefined;
  }
}

const sameConfig = (a: AudioDecoderConfig | undefined, b: AudioDecoderConfig) =>
  a !== undefined &&
  a.codec === b.codec &&
  a.sampleRate === b.sampleRate &&
  a.channels === b.channels;
