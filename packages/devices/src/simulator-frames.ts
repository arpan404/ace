import type { ScreenStreamSettings } from "@ace/protocol";
import { jpegComplete } from "./jpeg.ts";
import { DeviceError } from "./sdk.ts";
import { deviceImageStream } from "./stream-control.ts";

type Image = { bytes: Buffer; width: number; height: number };
/** The frame packet's tallest picture, a portrait phone's included. */
const frameHeightLimit = 2160;

/**
 * serve-sim's picture is larger than a frame can carry. Nothing here scales it (ace-media owns
 * every image, X1): the still is taken another way, by ace-media or the device's own screenshot.
 */
export class StillTooLarge extends Error {
  constructor(width: number, height: number) {
    super(`The Simulator's ${width}×${height} picture is larger than a still frame carries`);
  }
}

/**
 * serve-sim's pictures as the capture's stills, published as they came: one inside the stream's
 * box (and the frame packet's 2160-pixel height) goes out at once; a larger one is never
 * re-encoded here, and a still waiting for it is refused with `StillTooLarge`. Only the latest
 * picture is kept while one is being handed on.
 */
export class SimulatorFrames {
  private settings: ScreenStreamSettings;
  private revision = 0;
  private stopped = false;
  private latest: Image | undefined;
  private pending: Image | undefined;
  private running: Promise<void> | undefined;
  private last = -Infinity;
  private cancel: (() => void) | undefined;
  private readonly waiters = new Set<{
    revision: number;
    resolve(): void;
    reject(error: unknown): void;
  }>();
  private readonly options: {
    fps: number;
    now(): number;
    after(ms: number, run: () => void): () => void;
    publish(image: Image, scale: number): void;
    failure(error: unknown): void;
  };
  constructor(options: SimulatorFrames["options"]) {
    this.options = options;
    this.settings = { ...deviceImageStream, fps: options.fps };
  }
  push(bytes: Buffer, width: number, height: number): void {
    if (this.stopped) return;
    this.latest = { bytes, width, height };
    const remaining = 1000 / this.settings.fps - (this.options.now() - this.last);
    if (remaining > 0) {
      this.cancel ??= this.options.after(remaining, () => {
        this.cancel = undefined;
        this.publishLatest();
      });
    } else this.publishLatest();
  }
  private publishLatest(): void {
    if (this.stopped) return;
    this.cancel?.();
    this.cancel = undefined;
    this.last = this.options.now();
    this.pending = this.latest;
    this.start();
  }
  private start(): void {
    if (this.running || this.stopped || !this.pending) return;
    this.running = this.drain().finally(() => {
      this.running = undefined;
      this.start();
    });
    void this.running.catch((error) => {
      for (const waiter of this.waiters) waiter.reject(error);
      this.waiters.clear();
      this.options.failure(error);
    });
  }
  private async drain(): Promise<void> {
    await Promise.resolve();
    while (this.pending && !this.stopped) {
      const source = this.pending;
      this.pending = undefined;
      const revision = this.revision;
      const settings = this.settings;
      // A cut-short frame would show an agent a screen that isn't there: refused.
      if (!jpegComplete(source.bytes))
        throw new DeviceError(
          "invalid_data",
          "The Simulator sent an incomplete picture",
          "Retry; if it persists, restart the device view.",
        );
      if (this.stopped || revision !== this.revision) continue;
      const fits =
        source.width <= settings.maxWidth &&
        source.height <= Math.min(frameHeightLimit, settings.maxHeight);
      if (fits) this.options.publish(source, 1);
      for (const waiter of this.waiters)
        if (waiter.revision <= revision) {
          this.waiters.delete(waiter);
          if (fits) waiter.resolve();
          else waiter.reject(new StillTooLarge(source.width, source.height));
        }
    }
  }
  /** Keeps `bytes` as the latest frame without publishing it: a still waits for `replay`. */
  hold(bytes: Buffer, width: number, height: number): void {
    if (!this.stopped) this.latest = { bytes, width, height };
  }
  /** New settings for stills on demand: nothing is published until `replay` asks. */
  idle(settings: ScreenStreamSettings): void {
    this.settings = settings;
    this.revision++;
    this.cancel?.();
    this.cancel = undefined;
    // A still already asked for still gets its frame, made at the new settings.
    if (this.waiters.size) {
      this.pending = this.latest;
      this.start();
    }
  }
  /** Drops the latest frame: the stream it came from closed, so it may no longer be current. */
  forget(): void {
    this.latest = undefined;
  }
  async configure(settings: ScreenStreamSettings): Promise<void> {
    this.settings = settings;
    this.revision++;
    // A wait timed at the old rate would hold back the next change; the replay covers it.
    this.cancel?.();
    this.cancel = undefined;
    // A picture over the new box isn't published, and isn't the stream's failure either.
    await this.replay().catch((error: unknown) => {
      if (!(error instanceof StillTooLarge)) throw error;
    });
  }
  async replay(): Promise<void> {
    if (!this.latest || this.stopped) return;
    if (this.waiters.size >= 64) throw new Error("Simulator frame request limit");
    const ready = Promise.withResolvers<void>();
    this.waiters.add({ revision: this.revision, resolve: ready.resolve, reject: ready.reject });
    this.pending = this.latest;
    this.start();
    await ready.promise;
  }
  async stop(): Promise<void> {
    for (const waiter of this.waiters) waiter.reject(new Error("Simulator frames stopped"));
    this.waiters.clear();
    this.cancel?.();
    this.cancel = undefined;
    this.stopped = true;
    this.revision++;
    this.pending = undefined;
    this.latest = undefined;
    await this.running;
  }
}
