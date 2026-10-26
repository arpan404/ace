import type { Schedule } from "../schedule.ts";
import type { StreamMessage } from "@ace/client";
import { within, type VideoDecoderFactory, type VideoSupport } from "@/lib/video/codecs.ts";
import { VideoStream, type VideoPicture } from "@/lib/video/stream.ts";

/** One encoded chunk of a thread's video, as the daemon's stream message carries it. */
export type BrowserVideoChunk = Extract<StreamMessage, { kind: "browser.video" }>["chunk"];

export interface ThreadVideosOptions {
  /** Absent: this client decodes no video, so it shows no live page. */
  decoder: VideoDecoderFactory | undefined;
  support: VideoSupport;
  schedule: Schedule;
  /** Whether a picture shown now is seen, so its ack is due now rather than owed. */
  seen(threadId: string): boolean;
  /** Whether the thread's view is watched at all. */
  watching(threadId: string): boolean;
  /** A decoded picture to show; it is the receiver's to close. */
  present(threadId: string, picture: VideoPicture): void;
  ack(threadId: string, sequence: number, keyframe: boolean): void;
}

/** A support probe that hasn't answered by then is taken as "no video". */
const probeMs = 1_000;

interface Owed {
  sequence: number;
  keyframe: boolean;
}

/**
 * Each watched thread's video (ADR 0088): decoding, presenting and acking. Every chunk is acked
 * as soon as the decoder has it out (or at once when it can't be decoded), so the daemon's
 * window of unacknowledged chunks frees at decode speed, not at display rate. Acks for pictures
 * nobody sees (a hidden page, a native view on top) are owed until `settle`, which pauses the
 * daemon's stream; a native view on top also skips decoding, so the owed ack asks for a
 * keyframe to pick up again.
 */
export class ThreadVideos {
  #options: ThreadVideosOptions;
  #streams = new Map<string, VideoStream>();
  #owed = new Map<string, Owed>();
  #codecs: Promise<readonly string[]> | undefined;
  #decodes: boolean | undefined;
  constructor(options: ThreadVideosOptions) {
    this.#options = options;
    if (!options.decoder) this.#decodes = false;
  }
  /** The codecs to ask for in `browser.subscribe`; empty: none. Probed once. */
  codecs(): Promise<readonly string[]> {
    if (!this.#options.decoder) return Promise.resolve([]);
    this.#codecs ??= within(this.#options.support(), probeMs, [], this.#options.schedule).then(
      (codecs) => {
        this.#decodes = codecs.length > 0;
        return codecs;
      },
    );
    return this.#codecs;
  }
  /** Whether this client decodes any codec; undefined until `codecs()` has answered. */
  decodes(): boolean | undefined {
    return this.#decodes;
  }
  receive(threadId: string, chunk: BrowserVideoChunk, painted: boolean): void {
    const decoder = this.#options.decoder;
    if (!decoder || !this.#options.watching(threadId)) return;
    let stream = this.#streams.get(threadId);
    if (!stream) {
      stream = new VideoStream(
        decoder,
        {
          present: (picture) => this.#present(threadId, picture),
          ack: (sequence, keyframe) => this.#ack(threadId, sequence, keyframe === true),
        },
        // A decoder that stops answering is dropped and the page's encoder asked for a keyframe.
        { after: (ms, run) => this.#options.schedule(run, ms) },
      );
      this.#streams.set(threadId, stream);
    }
    if (!painted) {
      // Nothing draws it: skip decoding, and pick up from a keyframe once it shows again.
      stream.reset();
      this.#owe(threadId, chunk.sequence, true);
      return;
    }
    stream.receive(chunk);
  }
  /** The thread's stream starts over (a new subscription, another tab). */
  reset(threadId: string): void {
    this.#streams.get(threadId)?.reset();
    this.#owed.delete(threadId);
  }
  delete(threadId: string): void {
    this.#streams.get(threadId)?.close();
    this.#streams.delete(threadId);
    this.#owed.delete(threadId);
  }
  /** The thread's pictures are seen again: send what was owed. */
  settle(threadId: string): void {
    const owed = this.#owed.get(threadId);
    if (!owed) return;
    this.#owed.delete(threadId);
    this.#options.ack(threadId, owed.sequence, owed.keyframe);
  }
  dispose(): void {
    for (const stream of this.#streams.values()) stream.close();
    this.#streams.clear();
    this.#owed.clear();
  }
  #ack(threadId: string, sequence: number, keyframe: boolean): void {
    if (this.#options.seen(threadId) && !this.#owed.has(threadId))
      this.#options.ack(threadId, sequence, keyframe);
    else this.#owe(threadId, sequence, keyframe);
  }
  #owe(threadId: string, sequence: number, keyframe: boolean): void {
    const before = this.#owed.get(threadId);
    this.#owed.set(threadId, {
      sequence: Math.max(sequence, before?.sequence ?? -1),
      keyframe: keyframe || before?.keyframe === true,
    });
  }
  #present(threadId: string, video: VideoPicture): void {
    const sequence = video.picture.sequence;
    if (!this.#options.watching(threadId)) return video.picture.close();
    this.#options.present(threadId, video);
    this.#ack(threadId, sequence, false);
  }
}
