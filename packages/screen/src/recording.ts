import { rm } from "node:fs/promises";
import type { RecordedPart, RecordingEnd } from "@ace/media/recordings";
import type { ActiveRecording, RecordingEncode } from "@ace/media/tee-recordings";
import type { Frame } from "./frames.ts";

/** A finished screen recording as ace-media wrote it: its MP4 parts, in order. */
export type RecordingArtifact = {
  id: string;
  /** The directory ace-media wrote the parts into. */
  directory: string;
  parts: RecordedPart[];
  /** Every part's bytes together. */
  bytes: number;
  mimeType: "video/mp4";
};

/** MediaFrame codecs: H.264 Annex B, as the helpers write it, and JPEG. */
const H264AnnexB = 1;
const Jpeg = 7;

/** The largest even size at or below `value`, at least 64, as encoders take. */
const even = (value: number) => Math.max(64, 2 * Math.floor(value / 2));

/**
 * The one encode ace-media runs for a recording of a JPEG-only screen: its pictures fitted
 * inside 1920×1080, at 15 frames a second.
 */
export function screenRecordingEncode(picture: { width: number; height: number } | undefined) {
  const size = picture ?? { width: 1280, height: 720 };
  const fit = Math.min(1, 1920 / size.width, 1080 / size.height);
  return {
    codec: "avc1.42E033",
    width: even(size.width * fit),
    height: even(size.height * fit),
    fps: 15,
    bitrate: 4_000_000,
  } satisfies RecordingEncode;
}

/**
 * One screen recording (X1): ace-media writes it as MP4 parts. A screen whose helper encodes
 * H.264 tees that video in; a JPEG-only screen's pictures go in for ace-media to encode, whether
 * or not anyone watches. It ends once (stopped, at its size limit, or failed in ace-media), and
 * every later `stop` returns that result.
 */
export class ScreenRecording {
  readonly id: string;
  readonly #recording: ActiveRecording;
  readonly #directory: string;
  readonly #pictures: boolean;
  readonly #publish: (artifact: RecordingArtifact) => Promise<void>;
  #result: Promise<RecordingArtifact> | undefined;
  #discarded = false;

  constructor(options: {
    id: string;
    directory: string;
    recording: ActiveRecording;
    /** The screen's pictures are recorded (a JPEG-only helper); otherwise its H.264. */
    pictures: boolean;
    publish: (artifact: RecordingArtifact) => Promise<void>;
  }) {
    this.id = options.id;
    this.#directory = options.directory;
    this.#recording = options.recording;
    this.#pictures = options.pictures;
    this.#publish = options.publish;
  }

  /** A frame the session took: its pictures or its video, whichever this recording records. */
  push(frame: Frame): void {
    if (this.#result) return;
    const { header, payload } = frame;
    if (this.#pictures) {
      if (header.codec !== "jpeg") return;
      this.#recording.push({
        kind: "picture",
        keyframe: true,
        codec: Jpeg,
        width: header.width,
        height: header.height,
        payload,
      });
      return;
    }
    if (header.codec !== "h264") return;
    this.#recording.push({
      kind: "video",
      keyframe: header.keyframe === true,
      codec: H264AnnexB,
      width: header.width,
      height: header.height,
      payload,
    });
  }

  /** Stops (once) and publishes the parts ace-media wrote. */
  stop(): Promise<RecordingArtifact> {
    return (this.#result ??= this.#recording.stop().then((end) => this.#published(end)));
  }

  /** ace-media ended the recording itself: publish what it wrote. */
  ended(end: RecordingEnd): Promise<RecordingArtifact> {
    return (this.#result ??= this.#published(end));
  }

  /** A recording that started too late to be kept: stopped, and its parts removed. */
  async discard(): Promise<void> {
    this.#discarded = true;
    await this.stop().catch(() => {});
    await rm(this.#directory, { recursive: true, force: true });
  }

  async #published(end: RecordingEnd): Promise<RecordingArtifact> {
    const artifact: RecordingArtifact = {
      id: this.id,
      directory: this.#directory,
      parts: end.parts,
      bytes: end.parts.reduce((sum, part) => sum + part.bytes, 0),
      mimeType: "video/mp4",
    };
    // Published even with no parts (a screen that showed nothing new), as the person asked for it.
    if (!this.#discarded) await this.#publish(artifact);
    // What was written is saved, but a failed recording's stop says why.
    if (!end.ok) throw new Error(`The recording failed: ${end.reason}`);
    return artifact;
  }
}
