import { encodeDeviceFrame, type DeviceFrameChunk } from "@ace/browser/stream";
import { VideoFanout, type VideoWindow } from "@ace/browser/video-fanout";
import type { Frame } from "@ace/screen";

/** Forced keyframes for one viewer at most this often (ADR 0088's per-encode gap). */
export const deviceKeyframeGapMs = 500;

/** A picture waiting for its viewer's window, encoded only when it is sent. */
interface Picture {
  sequence: number;
  key: boolean;
  bytes: Uint8Array;
  header: Omit<DeviceFrameChunk, "bytes">;
}

export interface DeviceMediaPorts {
  /** Writes one picture's pieces back to back; false: the transport is backed up, none written. */
  write(pieces: Uint8Array[]): boolean;
  /** The envelope's message id for the next picture (per connection). */
  messageId(): number;
  /** Ask the device's capture for a keyframe. */
  keyframe(): void;
  now(): number;
  after(ms: number, run: () => void): () => void;
  window?: VideoWindow;
}

/** The internal frame as the stream kind carries it. */
export function deviceFrameChunk(frame: Frame): Omit<DeviceFrameChunk, "bytes"> {
  const header = frame.header;
  return {
    sequence: header.sequence,
    timestamp: header.timestamp,
    width: header.width,
    height: header.height,
    scale: header.scale ?? 1,
    rotation: header.rotation ?? 0,
    codec: header.codec === "jpeg" ? "jpeg" : (header.videoCodec ?? "avc1.42E01F"),
    key: header.codec === "jpeg" || header.keyframe === true,
    streamId: header.sessionId,
  };
}

/**
 * One connection's view of one device on the shared media stream: its pictures go out as stream
 * kind `deviceFrame` at the pace the viewer acks them, with the browser video's window and drop
 * rules (`VideoFanout`). A JPEG stands alone, so a slow JPEG viewer simply gets the newest one
 * when its window opens; an H.264 viewer that loses a delta skips to the next keyframe, which is
 * asked for at once. A new capture (stream id) starts the viewer over at a keyframe.
 */
export class DeviceMediaViewer {
  readonly #deviceId: string;
  readonly #ports: DeviceMediaPorts;
  readonly #fanout: VideoFanout<Picture>;
  #stream: string | undefined;
  #codec: string | undefined;
  #lastKeyframe = -Infinity;
  #cancelKeyframe: (() => void) | undefined;
  #closed = false;
  constructor(deviceId: string, ports: DeviceMediaPorts) {
    this.#deviceId = deviceId;
    this.#ports = ports;
    this.#fanout = new VideoFanout<Picture>({
      keyframe: () => this.#askKeyframe(),
      playing: () => {},
      ...(ports.window ? { window: ports.window } : {}),
    });
  }
  /** A picture from the device's capture. */
  push(frame: Frame): void {
    if (this.#closed) return;
    const header = deviceFrameChunk(frame);
    // Captures name the codec on keyframes; a delta is in its keyframe's.
    if (header.codec !== "jpeg") {
      if (frame.header.videoCodec) this.#codec = header.codec;
      else if (this.#codec && header.streamId === this.#stream) header.codec = this.#codec;
    }
    if (header.streamId !== this.#stream) {
      // Acks and the window belong to one capture; a new one starts clean, at a keyframe.
      this.#stream = header.streamId;
      this.#fanout.add("viewer", { send: (picture) => this.#send(picture) });
      this.#fanout.assign("viewer", header.streamId);
    }
    this.#fanout.publish(header.streamId, {
      sequence: header.sequence,
      key: header.key,
      bytes: frame.payload,
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
  #send(picture: Picture): boolean {
    if (this.#closed) return false;
    return this.#ports.write(
      encodeDeviceFrame(this.#ports.messageId(), this.#deviceId, picture.header, picture.bytes),
    );
  }
  #askKeyframe(): void {
    if (this.#closed || this.#cancelKeyframe) return;
    const wait = this.#lastKeyframe + deviceKeyframeGapMs - this.#ports.now();
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
