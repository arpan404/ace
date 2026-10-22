import type { EncodedChunk, VideoHost } from "@ace/browser";
import { annexB, avcConfig, type AvcConfig } from "@ace/browser/h264";
import type { ScreenStreamSettings } from "@ace/protocol";
import { framePacket, type Frame } from "./frames.ts";

/** What a viewer's stream from pictures comes to: an encode of this codec, size and rate. */
export function pictureEncode(
  picture: { width: number; height: number },
  settings: Pick<ScreenStreamSettings, "maxWidth" | "maxHeight" | "fps" | "bitrate">,
  codec: string,
) {
  const scale = Math.min(1, settings.maxWidth / picture.width, settings.maxHeight / picture.height);
  const width = Math.max(64, Math.floor((picture.width * scale) / 2) * 2);
  const height = Math.max(64, Math.floor((picture.height * scale) / 2) * 2);
  return {
    key: `${codec}:${width}x${height}`,
    codec,
    width,
    height,
    fps: settings.fps,
    bitrate: settings.bitrate,
  };
}

/** H.264 in AVC form, as the encoder Chrome offers it; High first, then Baseline. */
const codecs = ["avc1.640033", "avc1.42E033"];

/** A JPEG-only session's pictures, encoded as one viewer's H.264. */
export interface PictureVideo {
  /** One JPEG picture of the session, as its helper made it. */
  push(frame: Frame): void;
  configure(settings: ScreenStreamSettings): void;
  keyframe(): void;
  close(): void;
}

/**
 * A computer-use session whose helper only makes JPEG (Linux and Windows, ADR 0048/0049) as live
 * video: the browser service's encoder-only Chrome encodes its pictures with the platform's
 * encoder (hardware where Chrome has one), and each chunk is rewritten as Annex B with the
 * parameter sets on keyframes, as the Mac helper's own H.264 arrives. Viewers get only video.
 */
export async function picturesAsVideo(options: {
  host: VideoHost;
  sessionId: string;
  /** The session's pictures: the first one sizes the encode; another size opens a new one. */
  first: Frame;
  settings: ScreenStreamSettings;
  now(): number;
  frame(frame: Frame): void;
  ended(): void;
}): Promise<PictureVideo | undefined> {
  const { host } = options;
  const encodePictures = host.encodePictures;
  if (!encodePictures) return undefined;
  const size = { width: options.first.header.width, height: options.first.header.height };
  // Asked at the size it will encode (even, as H.264 needs), not the picture's: a window can
  // be any width, and encoders refuse an odd one.
  const sized = pictureEncode(size, options.settings, "");
  const supported = await host.supported(codecs, sized.width, sized.height).catch(() => []);
  const codec = supported[0];
  if (!codec) return undefined;
  let settings = options.settings;
  let encode = pictureEncode(size, settings, codec);
  let config: AvcConfig | undefined;
  let sequence = 0;
  let closed = false;
  let pictureScale = options.first.header.scale ?? 1;
  const encoded = (chunk: EncodedChunk) => {
    if (closed || chunk.encode !== encode.key) return;
    if (chunk.description) config = avcConfig(Buffer.from(chunk.description));
    if (!config) return;
    const payload = annexB(Buffer.from(chunk.bytes), config, chunk.key);
    const header = {
      version: 1 as const,
      sessionId: options.sessionId,
      sequence: sequence++,
      timestamp: options.now(),
      width: chunk.codedWidth,
      height: chunk.codedHeight,
      scale: (pictureScale * chunk.codedWidth) / size.width,
      codec: "h264" as const,
      keyframe: chunk.key,
      ...(chunk.key ? { videoCodec: config.codec } : {}),
      bytes: payload.length,
    };
    const packet = framePacket(header, payload);
    options.frame({ header, payload: packet.subarray(packet.length - payload.length), packet });
  };
  const handle = await encodePictures(size.width, size.height, {
    chunk: (value) => {
      try {
        encoded(value);
      } catch {
        // A chunk that doesn't parse is skipped; the viewer asks for a keyframe on the gap.
      }
    },
    failed: () => {
      if (!closed) options.ended();
    },
    ended: () => {
      if (!closed) options.ended();
    },
  });
  handle.encodes([encode]);
  return {
    push(frame) {
      if (closed || frame.header.codec !== "jpeg") return;
      if (frame.header.width !== size.width || frame.header.height !== size.height) {
        // The window changed size: the encode follows on the next picture of the new size.
        size.width = frame.header.width;
        size.height = frame.header.height;
        encode = pictureEncode(size, settings, codec);
        handle.encodes([encode]);
      }
      pictureScale = frame.header.scale ?? pictureScale;
      handle.pictures?.push(frame.payload.toString("base64"));
    },
    configure(next) {
      settings = next;
      encode = pictureEncode(size, settings, codec);
      handle.encodes([encode]);
    },
    keyframe: () => handle.keyframe(encode.key),
    close() {
      closed = true;
      handle.close();
    },
  };
}

/**
 * One viewer's video of a session whose helper only makes JPEG: nothing until the viewer asks
 * (`want`), then an encode started from the next picture and kept to the viewer's settings.
 */
export interface PicturesToVideoOptions {
  host(): VideoHost | undefined;
  sessionId: string;
  now(): number;
  frame(frame: Frame): void;
}

export class PicturesToVideo {
  readonly #options: PicturesToVideoOptions;
  #wanted: ScreenStreamSettings | undefined;
  #video: PictureVideo | undefined;
  /** The session's newest picture: a still window sends no other to start an encode from. */
  #latest: Frame | undefined;
  #opening = false;
  #closed = false;
  constructor(options: PicturesToVideoOptions) {
    this.#options = options;
  }
  /** The viewer's request: true when this machine can encode the pictures (video will come). */
  want(settings: ScreenStreamSettings): boolean {
    if (this.#closed || !this.#options.host()?.encodePictures) return false;
    this.#wanted = settings;
    this.#video?.configure(settings);
    if (!this.#video && this.#latest) this.push(this.#latest);
    return true;
  }
  /** The helper encodes video itself after all: pictures aren't needed. */
  stop(): void {
    this.#wanted = undefined;
    this.#video?.close();
    this.#video = undefined;
  }
  push(frame: Frame): void {
    if (this.#closed || frame.header.codec !== "jpeg") return;
    this.#latest = frame;
    if (!this.#wanted) return;
    if (this.#video) return this.#video.push(frame);
    if (this.#opening) return;
    const host = this.#options.host();
    if (!host) return;
    this.#opening = true;
    void picturesAsVideo({
      host,
      sessionId: this.#options.sessionId,
      first: frame,
      settings: this.#wanted,
      now: this.#options.now,
      frame: (encoded) => {
        if (!this.#closed) this.#options.frame(encoded);
      },
      ended: () => {
        this.#video = undefined;
      },
    })
      .then((video) => {
        if (this.#closed || !this.#wanted) return video?.close();
        this.#video = video;
        // Pictures that came while it opened were held back: the encode starts from the newest.
        video?.push(this.#latest ?? frame);
      })
      .catch(() => {})
      .finally(() => {
        this.#opening = false;
      });
  }
  /** A keyframe for the viewer; false when this isn't the session's video. */
  keyframe(): boolean {
    if (!this.#video) return false;
    this.#video.keyframe();
    return true;
  }
  close(): void {
    this.#closed = true;
    this.#latest = undefined;
    this.stop();
  }
}
