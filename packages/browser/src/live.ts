import { z } from "zod";
import type { BrowserCdp } from "./backend.ts";
import type { BrowserFrame } from "@ace/protocol";
import { Screencast } from "./cdp.ts";
import { captureSettings, FrameFanout } from "./fanout.ts";

const Ack = z.object({ sessionId: z.number().int() });
export class LiveCapture {
  readonly fanout = new FrameFanout();
  private cdp: BrowserCdp;
  private now: () => number;
  private onFrame: (frame: BrowserFrame) => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private sequence = 0;
  private lastFrame = -Infinity;
  private lastAdapt = -Infinity;
  private settings = captureSettings(false);
  private adapting = false;
  private closed = false;
  constructor(cdp: BrowserCdp, now: () => number, onFrame: (frame: BrowserFrame) => void) {
    this.cdp = cdp;
    this.now = now;
    this.onFrame = onFrame;
  }
  private receive = (raw: unknown): void => {
    const ack = Ack.safeParse(raw);
    if (ack.success) void this.cdp.send("Page.screencastFrameAck", ack.data).catch(() => {});
    const parsed = Screencast.safeParse(raw);
    if (!parsed.success || this.closed) return;
    const timestamp = this.now();
    if (timestamp - this.lastFrame < 1000 / this.settings.fps) return;
    this.lastFrame = timestamp;
    const frame: BrowserFrame = {
      sequence: ++this.sequence,
      timestamp,
      data: parsed.data.data,
      width: parsed.data.metadata.deviceWidth,
      height: parsed.data.metadata.deviceHeight,
    };
    this.fanout.publish(frame);
    this.onFrame(frame);
  };
  async start(): Promise<void> {
    if (this.closed) throw new Error("Browser capture closed");
    this.cdp.on("Page.screencastFrame", this.receive);
    await this.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: this.settings.quality,
      maxWidth: 1280,
      maxHeight: 960,
    });
    if (this.closed) throw new Error("Browser capture closed");
    // A static about:blank page may emit no screencast event. Seed the view so a
    // subscriber never has to wait for the first user/agent action to see pixels.
    const sequence = this.sequence;
    const initial = z.object({ data: z.string().max(4 * 1024 * 1024) }).parse(
      await this.cdp.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: this.settings.quality,
      }),
    );
    if (this.closed) throw new Error("Browser capture closed");
    if (this.sequence === sequence) {
      const frame: BrowserFrame = {
        sequence: ++this.sequence,
        timestamp: this.now(),
        data: initial.data,
        width: 1280,
        height: 720,
      };
      this.fanout.publish(frame);
      this.onFrame(frame);
    }
    this.timer = setInterval(() => {
      this.fanout.flush();
      const settings = captureSettings(this.fanout.pressured);
      if (
        this.closed ||
        this.adapting ||
        settings.quality === this.settings.quality ||
        this.now() - this.lastAdapt < 2000
      )
        return;
      this.lastAdapt = this.now();
      this.adapting = true;
      this.settings = settings;
      void (async () => {
        await this.cdp.send("Page.stopScreencast");
        if (!this.closed)
          await this.cdp.send("Page.startScreencast", {
            format: "jpeg",
            quality: settings.quality,
            maxWidth: 1280,
            maxHeight: 960,
          });
      })()
        .catch(() => {})
        .finally(() => {
          this.adapting = false;
        });
    }, 100);
    this.timer.unref();
  }
  detach(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.cdp.off("Page.screencastFrame", this.receive);
    this.fanout.invalidate();
  }
  async replace(cdp: BrowserCdp): Promise<void> {
    this.detach();
    this.cdp = cdp;
    this.closed = false;
    this.lastFrame = -Infinity;
    await this.start();
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    this.cdp.off("Page.screencastFrame", this.receive);
    this.fanout.clear();
    await this.cdp.send("Page.stopScreencast").catch(() => {});
  }
}
