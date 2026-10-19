import type { ScreenStreamSettings } from "@ace/protocol";
import { MjpegDecoder } from "./mjpeg.ts";
import { SimulatorFrames } from "./simulator-frames.ts";

type Image = { bytes: Buffer; width: number; height: number };

/**
 * serve-sim's MJPEG stream, resized and re-compressed to the viewers' budget. This is the
 * fallback for viewers that can't decode the H.264 stream, and the source of still images.
 */
export class SimulatorJpeg {
  private readonly controller = new AbortController();
  private readonly frames: SimulatorFrames;
  private reading: Promise<void> | undefined;
  private readonly options: {
    url: URL;
    fps: number;
    fetch: typeof fetch;
    now(): number;
    after(ms: number, run: () => void): () => void;
    /** The native size of each JPEG serve-sim sends, before any resize. */
    source(width: number, height: number): void;
    publish(image: Image, scale: number): void;
    failure(error: unknown): void;
  };
  constructor(options: SimulatorJpeg["options"]) {
    this.options = options;
    this.frames = new SimulatorFrames({
      fps: options.fps,
      now: options.now,
      after: options.after,
      failure: options.failure,
      publish: options.publish,
    });
  }
  /** Resolves once serve-sim has accepted the stream request. */
  async start(): Promise<void> {
    const { signal } = this.controller;
    const response = await this.options.fetch(this.options.url, { signal, redirect: "error" });
    const type = response.headers.get("content-type") ?? "";
    if (!response.ok || !response.body || !type.startsWith("multipart/x-mixed-replace"))
      throw new Error("Simulator framebuffer stream unavailable");
    const boundary = /boundary=([A-Za-z0-9_-]{1,70})(?:;|$)/.exec(type)?.[1];
    if (!boundary) throw new Error("Simulator multipart boundary unavailable");
    const decoder = new MjpegDecoder(boundary, (image, width, height) => {
      this.options.source(width, height);
      this.frames.push(image, width, height);
    });
    const body = response.body;
    this.reading = (async () => {
      for await (const chunk of body) {
        if (signal.aborted) return;
        decoder.push(Buffer.from(chunk));
      }
      if (!signal.aborted) throw new Error("Simulator framebuffer stream ended");
    })();
    void this.reading.catch((error: unknown) => {
      if (!signal.aborted) this.options.failure(error);
    });
  }
  configure(settings: ScreenStreamSettings): Promise<void> {
    return this.frames.configure(settings);
  }
  replay(): Promise<void> {
    return this.frames.replay();
  }
  async stop(): Promise<void> {
    this.controller.abort();
    await this.frames.stop();
    await this.reading?.catch(() => {});
  }
}
