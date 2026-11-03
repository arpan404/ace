import type { ScreenStreamSettings } from "@ace/protocol";
import { MjpegDecoder } from "./mjpeg.ts";
import { SimulatorFrames } from "./simulator-frames.ts";
import { deviceStillStream, sameDeviceStream } from "./stream-control.ts";

type Image = { bytes: Buffer; width: number; height: number };
type Ask = { resolve(): void; reject(error: unknown): void };

/** How long a still waits for serve-sim's next picture. */
const stillTimeoutMs = 5000;

/**
 * serve-sim's MJPEG stream, resized and re-compressed to an image budget: agents' stills and
 * recordings while nobody watches. Live views never get it; they take the H.264 stream.
 *
 * serve-sim sends its picture several times a second even when the screen is still, and has no
 * way to send fewer. So while the capture is on stills (`deviceStillStream`) the stream stays
 * closed: a still opens it, takes the first picture serve-sim sends (its current screen) and
 * closes it again. A recording keeps it open and takes every picture, as before.
 */
export class SimulatorJpeg {
  private readonly frames: SimulatorFrames;
  /** The open MJPEG request, while there is one. */
  private link: AbortController | undefined;
  private opening: Promise<void> | undefined;
  private reading: Promise<void> | undefined;
  /** Every picture is published (startup, a recording); false while stills come on demand. */
  private streaming = true;
  private stopped = false;
  /** Stills waiting for the next picture serve-sim sends. */
  private readonly asks = new Set<Ask>();
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
  start(): Promise<void> {
    return this.open();
  }
  async configure(settings: ScreenStreamSettings): Promise<void> {
    if (sameDeviceStream(settings, deviceStillStream)) {
      this.streaming = false;
      this.frames.idle(settings);
      if (!this.asks.size) this.close();
      return;
    }
    // A picture kept from before the stream closed may be out of date: wait for a new one.
    if (!this.link) this.frames.forget();
    this.streaming = true;
    await this.open();
    await this.frames.configure(settings);
  }
  /** Publishes the screen as it is now: the latest picture, or a new one while on stills. */
  async replay(): Promise<void> {
    if (!this.streaming) await this.next();
    await this.frames.replay();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    for (const ask of this.asks) ask.reject(new Error("Simulator stream stopped"));
    this.asks.clear();
    this.close();
    await this.frames.stop();
    await this.reading?.catch(() => {});
  }
  /** Resolves on the first picture serve-sim sends after the call. */
  private next(): Promise<void> {
    if (this.asks.size >= 64) throw new Error("Simulator frame request limit");
    const asked = Promise.withResolvers<void>();
    const ask: Ask = { resolve: asked.resolve, reject: asked.reject };
    this.asks.add(ask);
    const give = (error: unknown) => {
      if (!this.asks.delete(ask)) return;
      ask.reject(error);
      if (!this.streaming && !this.asks.size) this.close();
    };
    const cancel = this.options.after(stillTimeoutMs, () =>
      give(new Error("The Simulator sent no picture in time")),
    );
    this.open().catch(give);
    return asked.promise.finally(cancel);
  }
  private open(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("Simulator stream stopped"));
    if (this.link) return Promise.resolve();
    return (this.opening ??= this.connect().finally(() => {
      this.opening = undefined;
    }));
  }
  private async connect(): Promise<void> {
    const controller = new AbortController();
    const { signal } = controller;
    try {
      const response = await this.options.fetch(this.options.url, { signal, redirect: "error" });
      const type = response.headers.get("content-type") ?? "";
      if (!response.ok || !response.body || !type.startsWith("multipart/x-mixed-replace"))
        throw new Error("Simulator framebuffer stream unavailable");
      const boundary = /boundary=([A-Za-z0-9_-]{1,70})(?:;|$)/.exec(type)?.[1];
      if (!boundary) throw new Error("Simulator multipart boundary unavailable");
      if (this.stopped) throw new Error("Simulator stream stopped");
      const decoder = new MjpegDecoder(boundary, (image, width, height) =>
        this.received(image, width, height),
      );
      const body = response.body;
      this.link = controller;
      this.reading = (async () => {
        for await (const chunk of body) {
          if (signal.aborted) return;
          // A view of the chunk: the decoder copies what it keeps.
          decoder.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        }
        if (!signal.aborted) throw new Error("Simulator framebuffer stream ended");
      })();
      void this.reading.catch((error: unknown) => {
        if (!signal.aborted) this.dropped(controller, error);
      });
    } catch (error) {
      controller.abort();
      throw error;
    }
  }
  private received(bytes: Buffer, width: number, height: number): void {
    this.options.source(width, height);
    if (this.streaming) this.frames.push(bytes, width, height);
    else this.frames.hold(bytes, width, height);
    const asked = [...this.asks];
    this.asks.clear();
    for (const ask of asked) ask.resolve();
    if (!this.streaming) this.close();
  }
  /** The stream broke. While streaming the capture has failed; on stills, only the stills. */
  private dropped(controller: AbortController, error: unknown): void {
    if (this.link === controller) this.link = undefined;
    controller.abort();
    for (const ask of this.asks) ask.reject(error);
    this.asks.clear();
    if (this.streaming) this.options.failure(error);
  }
  private close(): void {
    const link = this.link;
    this.link = undefined;
    link?.abort();
  }
}
