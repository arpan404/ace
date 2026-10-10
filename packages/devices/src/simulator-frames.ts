import type { ScreenStreamSettings } from "@ace/protocol";
import { jpegDimensions } from "./jpeg.ts";
import { deviceImageStream } from "./stream-control.ts";

type Image = { bytes: Buffer; width: number; height: number };
/** Retain only the latest native frame while one JPEG transform is outstanding. */
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
      // The packet protocol permits a 2160-pixel height, including portrait devices.
      const heightLimit = Math.min(2160, settings.maxHeight);
      const resize = source.width > settings.maxWidth || source.height > heightLimit;
      const budget = Math.max(16384, settings.bitrate / 8 / settings.fps);
      let image = source;
      if (resize || source.bytes.length > budget) {
        const { default: sharp } = await import("sharp");
        const bytes = await sharp(source.bytes)
          .resize({
            width: settings.maxWidth,
            height: heightLimit,
            fit: "inside",
            withoutEnlargement: true,
          })
          .jpeg({
            quality: Math.max(35, Math.min(85, Math.round((85 * budget) / source.bytes.length))),
          })
          .toBuffer();
        image = { bytes, ...jpegDimensions(bytes) };
      }
      if (!this.stopped && revision === this.revision) {
        this.options.publish(image, image.width / source.width);
        for (const waiter of this.waiters)
          if (waiter.revision <= revision) {
            this.waiters.delete(waiter);
            waiter.resolve();
          }
      }
    }
  }
  async configure(settings: ScreenStreamSettings): Promise<void> {
    this.settings = settings;
    this.revision++;
    await this.replay();
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
