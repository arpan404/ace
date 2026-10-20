/**
 * `dev:fake` only. The fake daemon's browser video carries its SVG page pictures (and a fake
 * device's "H.264" carries JPEG), which a real `VideoDecoder` can't decode. This stand-in for
 * WebCodecs' decoder decodes whatever image a chunk carries into an `ImageBitmap` that passes for
 * a `VideoFrame` where the app uses one: its timestamp, drawable, closed once replaced.
 */
export function installFakeVideoDecoder(target: typeof globalThis = globalThis): void {
  if (typeof target.createImageBitmap !== "function") return;
  class FakeVideoDecoder {
    static isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport> {
      return Promise.resolve({ supported: true, config });
    }
    state: CodecState = "unconfigured";
    decodeQueueSize = 0;
    #init: VideoDecoderInit;
    /** Pictures come out in the order their chunks went in. */
    #queue = Promise.resolve();
    constructor(init: VideoDecoderInit) {
      this.#init = init;
    }
    configure(): void {
      if (this.state !== "closed") this.state = "configured";
    }
    decode(chunk: EncodedVideoChunk): void {
      if (this.state !== "configured")
        throw new DOMException("The decoder isn't configured", "InvalidStateError");
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      const timestamp = chunk.timestamp;
      this.#queue = this.#queue
        .then(async () => {
          const bitmap = await picture(bytes);
          if (this.state !== "configured") return bitmap.close();
          Object.defineProperty(bitmap, "timestamp", { value: timestamp });
          // The bitmap stands in for a VideoFrame: drawable, timestamped, closable.
          this.#init.output(bitmap as unknown as VideoFrame);
        })
        .catch(() => {
          if (this.state !== "configured") return;
          this.state = "closed";
          this.#init.error(new DOMException("The picture can't be decoded", "EncodingError"));
        });
    }
    flush(): Promise<void> {
      return this.#queue;
    }
    reset(): void {
      if (this.state !== "closed") this.state = "unconfigured";
    }
    close(): void {
      this.state = "closed";
    }
  }
  // Only what the app calls is implemented.
  target.VideoDecoder = FakeVideoDecoder as unknown as typeof VideoDecoder;
}

/** An SVG data URL (the fake browser's pages) or an encoded image's bytes, as a bitmap. */
async function picture(bytes: Uint8Array): Promise<ImageBitmap> {
  if (new TextDecoder().decode(bytes.subarray(0, 5)) === "data:") {
    const image = new Image();
    image.src = new TextDecoder().decode(bytes);
    await image.decode();
    return createImageBitmap(image);
  }
  return createImageBitmap(new Blob([bytes.slice()]));
}
