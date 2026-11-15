import type { MediaLinkHint } from "@ace/protocol";
import { encodePicture, type PictureChunk, type PictureKind } from "./stream-picture.ts";
import { LinkRate, type LinkRateLimits } from "./link-rate.ts";
import { VideoFanout, type VideoWindow } from "./video-fanout.ts";

/** Earlier captures kept to route late acks, past those whose pictures are still on the wire. */
const recentCaptures = 4;
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

/** Weak memoization retains pieces only as long as their immutable captured picture. */
const piecesByPicture = new WeakMap<CapturedPicture, Map<string, Uint8Array[]>>();

/** A picture waiting for its viewer's window, encoded only when it is sent. */
interface Waiting {
  picture: CapturedPicture;
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
  /** Follow this viewer's link (`link-rate.ts`) within these bounds; `rate` says where it is. */
  link?: LinkRateLimits;
  /** What the viewer's client says about its link: it may start the rate lower. */
  hint?: MediaLinkHint;
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
  readonly #link: LinkRate | undefined;
  #stream: string | undefined;
  /** Recent captures' fanout generations: an ack names its capture, and frees only its own. */
  readonly #generations = new Map<string, number>();
  #codec: string | undefined;
  #lastKeyframe = -Infinity;
  #cancelKeyframe: (() => void) | undefined;
  #closed = false;
  constructor(kind: PictureKind, sourceId: string, ports: PictureViewerPorts) {
    this.#kind = kind;
    this.#sourceId = sourceId;
    this.#ports = ports;
    this.#link = ports.link ? new LinkRate(ports.link, ports.hint) : undefined;
    this.#fanout = new VideoFanout<Waiting>({
      keyframe: () => this.#askKeyframe(),
      playing: () => {},
      sent: (_id, sequence, bytes) => this.#link?.sent(sequence, bytes, this.#ports.now()),
      dropped: () => {
        if (!this.#link) return;
        this.#link.dropped(this.#ports.now());
        this.#fanout.bound("viewer", this.#link.backlogBytes);
      },
      lost: () => {
        if (!this.#link) return;
        this.#link.lost(this.#ports.now());
        this.#fanout.bound("viewer", this.#link.backlogBytes);
      },
      now: () => this.#ports.now(),
      ...(ports.window ? { window: ports.window } : {}),
    });
    this.#fanout.add("viewer", { send: (waiting) => this.#send(waiting) });
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
      // A new capture starts at a keyframe, in a sequence space of its own. The old one's
      // pictures still on the wire keep their place in the window until acked; the link's
      // estimate doesn't wait on their acks (it reads the new capture's).
      this.#stream = header.streamId;
      this.#fanout.assign("viewer", header.streamId);
      const generation = this.#fanout.generation("viewer");
      if (generation !== undefined) this.#generations.set(header.streamId, generation);
      this.#forgetCaptures();
      this.#link?.reset();
    }
    this.#fanout.publish(header.streamId, {
      picture,
      sequence: header.sequence,
      key: header.key,
      bytes,
      header,
    });
  }
  /** The viewer showed pictures up to `sequence`; `keyframe`: its decoder needs a fresh start. */
  ack(streamId: string, sequence: number, keyframe = false): void {
    if (this.#closed) return;
    const generation = this.#generations.get(streamId);
    if (generation === undefined) return;
    if (streamId !== this.#stream) {
      // An earlier capture's picture shown late: off the wire, nothing more.
      this.#fanout.acknowledge("viewer", sequence, generation);
      this.#forgetCaptures();
      return;
    }
    if (this.#link) {
      this.#link.acknowledged(sequence, this.#ports.now());
      // What is in flight is bounded by what the link carries in time, not only the window,
      // and no picture stays in flight longer than the link's lifetime.
      this.#fanout.bound("viewer", this.#link.backlogBytes);
      this.#fanout.lifetime("viewer", this.#link.lifetimeMs);
    }
    this.#fanout.acknowledge("viewer", sequence, generation);
    if (keyframe) this.#fanout.keyframe("viewer");
  }
  /** Bits per second this viewer's link carries now, when it is followed (`link`). */
  get rate(): number | undefined {
    return this.#link?.rate;
  }
  /** Whether that rate is still probing up from its start (`LinkRate.probing`). */
  get probing(): boolean {
    return this.#link?.probing ?? false;
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
    let cached = piecesByPicture.get(waiting.picture);
    if (!cached) {
      cached = new Map();
      piecesByPicture.set(waiting.picture, cached);
    }
    const key = `${this.#kind}:${this.#sourceId}:${waiting.header.codec}`;
    let pieces = cached.get(key);
    if (!pieces) {
      pieces = encodePicture(
        this.#kind,
        this.#ports.messageId(),
        this.#sourceId,
        waiting.header,
        waiting.bytes,
      );
      cached.set(key, pieces);
    }
    return this.#ports.write(pieces);
  }

  /**
   * Past `recentCaptures`, forgets the oldest earlier captures, but none whose pictures are
   * still on the wire: its late ack must still free them (and their lifetime bounds the wait).
   */
  #forgetCaptures(): void {
    for (const [stream, generation] of this.#generations) {
      if (this.#generations.size <= recentCaptures) return;
      if (stream !== this.#stream && !this.#fanout.owes("viewer", generation))
        this.#generations.delete(stream);
    }
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
