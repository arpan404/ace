import type { DeviceFrameChunk } from "@ace/browser/stream";
import type { PortableFrame } from "@ace/screen/frames-client";

/**
 * One picture of a device's screen as a view draws it, whichever way it came: a stream kind
 * `deviceFrame` message (paced: the daemon waits for its ack) or an older daemon's screen packet.
 */
export interface DevicePicture extends Omit<DeviceFrameChunk, "bytes"> {
  deviceId: string;
  bytes: Uint8Array;
  /** Arrived on the shared media stream: ack it once shown, or the daemon stops sending. */
  paced: boolean;
}

/** An older daemon's screen packet as a picture. */
export function packetPicture(deviceId: string, frame: PortableFrame): DevicePicture {
  const header = frame.header;
  const h264 = header.codec === "h264";
  return {
    deviceId,
    streamId: header.sessionId,
    sequence: header.version === 1 ? header.sequence : header.seq,
    timestamp: header.version === 1 ? header.timestamp : header.ts,
    width: header.width,
    height: header.height,
    scale: header.scale ?? 1,
    rotation: 0,
    codec: h264 ? (header.videoCodec ?? "avc1.42E01F") : "jpeg",
    key: !h264 || header.keyframe === true,
    bytes: frame.payload,
    paced: false,
  };
}

/** A view's pictures waiting to be drawn, at most this many. */
const queueLimit = 16;

interface Viewer {
  draw(picture: DevicePicture): Promise<void>;
  queue: DevicePicture[];
  busy: boolean;
  active: boolean;
}

/**
 * Each device's pictures to its views, in order and one draw at a time. H.264 can't skip a
 * picture, so nothing is replaced while there's room; a view that falls a whole queue behind
 * keeps only the newest picture, and its decoder sees the gap and asks for a keyframe. The
 * daemon's ack window keeps paced streams far below the limit.
 */
export class DevicePictures {
  readonly #viewers = new Map<string, Set<Viewer>>();
  watch(deviceId: string, draw: (picture: DevicePicture) => Promise<void>): () => void {
    let viewers = this.#viewers.get(deviceId);
    if (!viewers) {
      if (this.#viewers.size >= 4) throw new Error("Device frame view limit");
      viewers = new Set();
      this.#viewers.set(deviceId, viewers);
    }
    if (viewers.size >= 16) throw new Error("Device frame view limit");
    const viewer: Viewer = { draw, queue: [], busy: false, active: true };
    viewers.add(viewer);
    const set = viewers;
    return () => {
      viewer.active = false;
      viewer.queue = [];
      set.delete(viewer);
      if (!set.size && this.#viewers.get(deviceId) === set) this.#viewers.delete(deviceId);
    };
  }
  publish(picture: DevicePicture): void {
    for (const viewer of this.#viewers.get(picture.deviceId) ?? []) {
      if (viewer.queue.length >= queueLimit) viewer.queue = [];
      viewer.queue.push(picture);
      if (!viewer.busy) this.#drain(viewer);
    }
  }
  /** Forget queued pictures (the connection ended); the views stay. */
  discard(): void {
    for (const viewers of this.#viewers.values()) for (const viewer of viewers) viewer.queue = [];
  }
  #drain(viewer: Viewer): void {
    const next = viewer.queue.shift();
    if (!next || !viewer.active) {
      viewer.busy = false;
      return;
    }
    viewer.busy = true;
    void Promise.resolve()
      .then(() => viewer.draw(next))
      .catch(() => {})
      .then(() => this.#drain(viewer));
  }
}
