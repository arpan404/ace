import type { ScreenStreamSettings } from "@ace/protocol";
import { MjpegDecoder } from "./mjpeg.ts";
import { SimulatorFrames } from "./simulator-frames.ts";
import { deviceStillStream, sameDeviceStream } from "./stream-control.ts";

type Image = { bytes: Buffer; width: number; height: number };
/** One MJPEG request, from before its headers arrive until it is closed. */
type Link = {
  readonly controller: AbortController;
  /** Set once serve-sim has answered; counts the frames that have begun arriving. */
  decoder: MjpegDecoder | undefined;
  /** Resolves once serve-sim has accepted the request. */
  ready: Promise<void>;
  reading: Promise<void> | undefined;
};
/** A still waiting for a picture from `link` that began arriving after frame `after`. */
type Ask = { link: Link; after: number; resolve(): void; reject(error: unknown): void };

/** How long a still waits for serve-sim's next picture. */
const stillTimeoutMs = 5000;

/**
 * serve-sim's MJPEG stream, resized and re-compressed to an image budget: agents' stills and
 * recordings while nobody watches. Live views never get it; they take the H.264 stream.
 *
 * serve-sim sends its picture several times a second even when the screen is still, and has no
 * way to send fewer. So while the capture is on stills (`deviceStillStream`) the stream stays
 * closed: a still opens it, takes the first picture that starts arriving after it asked (on a
 * new request, serve-sim's current screen) and closes it again. A recording keeps it open and
 * takes every picture, as before.
 */
export class SimulatorJpeg {
  private readonly frames: SimulatorFrames;
  /** The MJPEG request, from the moment it is sent until it is closed. */
  private link: Link | undefined;
  /** Every picture is published (startup, a recording); false while stills come on demand. */
  private streaming = true;
  private stopped = false;
  /** Stills waiting for a picture newer than their request. */
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
    return this.open().ready;
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
    await this.open().ready;
    await this.frames.configure(settings);
  }
  /** Publishes the screen as it is now: the latest picture, or a new one while on stills. */
  async replay(): Promise<void> {
    if (!this.streaming) await this.next();
    await this.frames.replay();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    const link = this.link;
    this.close();
    for (const ask of this.asks) ask.reject(new Error("Simulator stream stopped"));
    this.asks.clear();
    await this.frames.stop();
    // The request is aborted; a reader still draining it ends on that abort.
    await link?.reading?.catch(() => {});
  }
  /** Resolves on the first picture that starts arriving after the call. */
  private next(): Promise<void> {
    if (this.asks.size >= 64) throw new Error("Simulator frame request limit");
    const link = this.open();
    const asked = Promise.withResolvers<void>();
    const ask: Ask = {
      link,
      // A picture already arriving may show the screen from before the agent's last action.
      after: link.decoder?.started ?? 0,
      resolve: asked.resolve,
      reject: asked.reject,
    };
    this.asks.add(ask);
    const give = (error: unknown) => {
      if (!this.asks.delete(ask)) return;
      ask.reject(error);
      // Nobody else waits on the request: close it, even if serve-sim never answered.
      if (!this.streaming && ![...this.asks].some((other) => other.link === link)) this.close(link);
    };
    const cancel = this.options.after(stillTimeoutMs, () =>
      give(new Error("The Simulator sent no picture in time")),
    );
    link.ready.catch(give);
    return asked.promise.finally(cancel);
  }
  /** The current request, or a new one. Its `ready` rejects once stopped. */
  private open(): Link {
    if (this.link) return this.link;
    const link: Link = {
      controller: new AbortController(),
      decoder: undefined,
      ready: Promise.resolve(),
      reading: undefined,
    };
    if (this.stopped) {
      link.ready = Promise.reject(new Error("Simulator stream stopped"));
      return link;
    }
    // The request is the link from now on, so a timeout, idle or stop can abort it before
    // serve-sim answers.
    this.link = link;
    link.ready = this.connect(link);
    // Its caller hears of a failed request; only a stream that breaks later fails the capture.
    link.ready.catch((error: unknown) => this.abandon(link, error));
    return link;
  }
  private async connect(link: Link): Promise<void> {
    const { signal } = link.controller;
    const response = await this.options.fetch(this.options.url, { signal, redirect: "error" });
    if (this.link !== link || signal.aborted) {
      // Closed while serve-sim was answering: this response is no one's.
      await response.body?.cancel().catch(() => {});
      throw new Error("Simulator stream closed");
    }
    const type = response.headers.get("content-type") ?? "";
    if (!response.ok || !response.body || !type.startsWith("multipart/x-mixed-replace"))
      throw new Error("Simulator framebuffer stream unavailable");
    const boundary = /boundary=([A-Za-z0-9_-]{1,70})(?:;|$)/.exec(type)?.[1];
    if (!boundary) throw new Error("Simulator multipart boundary unavailable");
    const decoder = new MjpegDecoder(boundary, (image, width, height, frame) =>
      this.received(link, image, width, height, frame),
    );
    const body = response.body;
    link.decoder = decoder;
    link.reading = (async () => {
      for await (const chunk of body) {
        if (signal.aborted) return;
        // A view of the chunk: the decoder copies what it keeps.
        decoder.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      }
      if (!signal.aborted) throw new Error("Simulator framebuffer stream ended");
    })();
    void link.reading.catch((error: unknown) => {
      if (signal.aborted) return;
      const current = this.link === link;
      this.abandon(link, error);
      if (current && this.streaming && !this.stopped) this.options.failure(error);
    });
  }
  private received(link: Link, bytes: Buffer, width: number, height: number, frame: number) {
    if (this.link !== link) return;
    this.options.source(width, height);
    if (this.streaming) this.frames.push(bytes, width, height);
    else this.frames.hold(bytes, width, height);
    for (const ask of this.asks)
      if (ask.link === link && frame > ask.after) {
        this.asks.delete(ask);
        ask.resolve();
      }
    if (!this.streaming && !this.asks.size) this.close();
  }
  /** A request failed: it is closed, and the stills waiting on it fail with it. */
  private abandon(link: Link, error: unknown): void {
    this.close(link);
    for (const ask of this.asks)
      if (ask.link === link) {
        this.asks.delete(ask);
        ask.reject(error);
      }
  }
  /** Aborts `link` (by default the current request), answered or not. */
  private close(link = this.link): void {
    if (!link) return;
    if (this.link === link) this.link = undefined;
    link.controller.abort();
  }
}
