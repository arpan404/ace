import type { Schedule } from "../schedule.ts";
import type { ScreenFrame } from "../sources.ts";
import { within, type VideoDecoderFactory, type VideoSupport } from "./video-codecs.ts";
import { VideoStream, type BrowserVideoChunk, type VideoPicture } from "./video-stream.ts";

/** A picture ready to show, and how to free it. */
export interface ShownVideo extends ScreenFrame {
  release(): void;
}

export interface ThreadVideosOptions {
  /** Absent: this client plays no video and asks for JPEG frames. */
  decoder: VideoDecoderFactory | undefined;
  support: VideoSupport;
  schedule: Schedule;
  /** Whether a picture shown now is seen, so its ack is due now rather than owed. */
  seen(threadId: string): boolean;
  /** Whether the thread's view is watched at all. */
  watching(threadId: string): boolean;
  present(threadId: string, frame: ShownVideo, timestamp: number): void;
  ack(threadId: string, sequence: number, keyframe: boolean): void;
}

/** A support probe that hasn't answered by then is taken as "no video". */
const probeMs = 1_000;

interface Owed {
  sequence: number;
  keyframe: boolean;
}

/**
 * Each watched thread's video (ADR 0088): decoding, presenting and acking. Acks for pictures
 * nobody sees (a hidden page, a native view on top) are owed until `settle`, which pauses the
 * daemon's stream as JPEG's owed acks do; a native view on top also skips decoding, so the
 * owed ack asks for a keyframe to pick up again.
 */
export class ThreadVideos {
  #options: ThreadVideosOptions;
  #streams = new Map<string, VideoStream>();
  #owed = new Map<string, Owed>();
  #codecs: Promise<readonly string[]> | undefined;
  constructor(options: ThreadVideosOptions) {
    this.#options = options;
  }
  /** The codecs to ask for in `browser.subscribe`; empty: ask for JPEG. Probed once. */
  codecs(): Promise<readonly string[]> {
    if (!this.#options.decoder) return Promise.resolve([]);
    this.#codecs ??= within(this.#options.support(), probeMs, [], this.#options.schedule);
    return this.#codecs;
  }
  receive(threadId: string, chunk: BrowserVideoChunk, painted: boolean): void {
    const decoder = this.#options.decoder;
    if (!decoder || !this.#options.watching(threadId)) return;
    let stream = this.#streams.get(threadId);
    if (!stream) {
      stream = new VideoStream(decoder, {
        present: (picture) => this.#present(threadId, picture),
        ack: (sequence, keyframe) => this.#ack(threadId, sequence, keyframe === true),
      });
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
  /** The thread's stream starts over (a new subscription, another tab, a JPEG frame). */
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
    const { picture } = video;
    if (!this.#options.watching(threadId)) return picture.close();
    let closed = false;
    this.#options.present(
      threadId,
      {
        sequence: picture.sequence,
        src: "",
        width: video.width,
        height: video.height,
        video: {
          codedWidth: video.codedWidth,
          codedHeight: video.codedHeight,
          draw(canvas) {
            if (closed) return false;
            const context = canvas.getContext("2d");
            if (!context) return false;
            try {
              picture.draw(context, canvas.width, canvas.height);
              return true;
            } catch {
              return false;
            }
          },
        },
        release() {
          if (closed) return;
          closed = true;
          picture.close();
        },
      },
      video.timestamp,
    );
    this.#ack(threadId, picture.sequence, false);
  }
}
