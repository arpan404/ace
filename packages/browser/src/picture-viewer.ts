import { encodePicture, type PictureChunk, type PictureKind } from "./stream-picture.ts";
import { VideoFanout, type VideoWindow } from "./video-fanout.ts";

/** Forced keyframes for one viewer at most this often (ADR 0088's per-encode gap). */
export const pictureKeyframeGapMs = 500;

/**
 * A captured picture as the daemon hands it to a viewer: the stream kind's header and bytes.
 * `codecNamed`: the capture named its H.264 codec on this picture (keyframes do); a delta that
 * doesn't is in its keyframe's codec.
 */
export interface CapturedPicture extends Omit<PictureChunk, "bytes" | "still"> {
  bytes: Uint8Array;
  codecNamed: boolean;
}

/** A picture waiting for its viewer's window, encoded only when it is sent. */
interface Waiting {
  sequence: number;
  key: boolean;
  bytes: Uint8Array;
  header: Omit<PictureChunk, "bytes">;
}

export interface PictureViewerPorts {
  /** Writes one picture's pieces back to back; false: the transport is backed up, none written. */
  write(pieces: Uint8Array[]): boolean;
  /** The envelope's message id for the next picture (per connection). */
  messageId(): number;
  /** Ask the source's capture for a keyframe. */
  keyframe(): void;
  now(): number;
  after(ms: number, run: () => void): () => void;
  window?: VideoWindow;
}

/**
 * One connection's view of one source (a device, a computer-use session) on the shared media
 * stream: its pictures go out as a picture kind at the pace the viewer acks them, with the
 * browser video's window and drop rules (`VideoFanout`). A JPEG stands alone, so a slow JPEG
 * viewer simply gets the newest one when its window opens; an H.264 viewer that loses a delta
 * skips to the next keyframe, which is asked for at once. A new capture (stream id) starts the
 * viewer over at a keyframe.
 */
export class PictureViewer {
  readonly #kind: PictureKind;
  readonly #sourceId: string;
  readonly #ports: PictureViewerPorts;
  readonly #fanout: VideoFanout<Waiting>;
  #stream: string | undefined;
  #codec: string | undefined;
  #lastKeyframe = -Infinity;
  #cancelKeyframe: (() => void) | undefined;
  #closed = false;
  constructor(kind: PictureKind, sourceId: string, ports: PictureViewerPorts) {
    this.#kind = kind;
    this.#sourceId = sourceId;
    this.#ports = ports;
    this.#fanout = new VideoFanout<Waiting>({
      keyframe: () => this.#askKeyframe(),
      playing: () => {},
      ...(ports.window ? { window: ports.window } : {}),
    });
  }
  /** A picture from the source's capture. */
  push(picture: CapturedPicture): void {
    if (this.#closed) return;
    const { bytes, codecNamed, ...header } = picture;
    // Captures name the codec on keyframes; a delta is in its keyframe's.
    if (header.codec !== "jpeg") {
      if (codecNamed) this.#codec = header.codec;
      else if (this.#codec && header.streamId === this.#stream) header.codec = this.#codec;
    }
    if (header.streamId !== this.#stream) {
      // Acks and the window belong to one capture; a new one starts clean, at a keyframe.
      this.#stream = header.streamId;
      this.#fanout.add("viewer", { send: (waiting) => this.#send(waiting) });
      this.#fanout.assign("viewer", header.streamId);
    }
    this.#fanout.publish(header.streamId, {
      sequence: header.sequence,
      key: header.key,
      bytes,
      header,
    });
  }
  /** The viewer showed pictures up to `sequence`; `keyframe`: its decoder needs a fresh start. */
  ack(streamId: string, sequence: number, keyframe = false): void {
    if (this.#closed || streamId !== this.#stream) return;
    this.#fanout.acknowledge("viewer", sequence);
    if (keyframe) this.#fanout.keyframe("viewer");
  }
  /** The transport drained: retry what it refused. */
  flush(): void {
    if (!this.#closed) this.#fanout.flush();
  }
  close(): void {
    this.#closed = true;
    this.#cancelKeyframe?.();
    this.#fanout.clear();
  }
  #send(waiting: Waiting): boolean {
    if (this.#closed) return false;
    return this.#ports.write(
      encodePicture(
        this.#kind,
        this.#ports.messageId(),
        this.#sourceId,
        waiting.header,
        waiting.bytes,
      ),
    );
  }
  #askKeyframe(): void {
    if (this.#closed || this.#cancelKeyframe) return;
    const wait = this.#lastKeyframe + pictureKeyframeGapMs - this.#ports.now();
    if (wait <= 0) {
      this.#lastKeyframe = this.#ports.now();
      this.#ports.keyframe();
      return;
    }
    // Asked again too soon: one request goes once the gap has passed, never a burst.
    this.#cancelKeyframe = this.#ports.after(wait, () => {
      this.#cancelKeyframe = undefined;
      this.#askKeyframe();
    });
  }
}
