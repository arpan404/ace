import { z } from "zod";
import type { BrowserCdp } from "./backend.ts";
import type { BrowserFrame } from "@ace/protocol";
import { Screencast } from "./cdp.ts";
import { captureSettings, CapturePressure, FrameFanout } from "./fanout.ts";

const Ack = z.object({ sessionId: z.number().int() });
export class LiveCapture {
  readonly fanout = new FrameFanout();
  private cdp: BrowserCdp;
  private now: () => number;
  private onFrame: (frame: BrowserFrame, epoch: number) => void;
  private privacy: () => { epoch: number; since: number };
  private timer: ReturnType<typeof setInterval> | undefined;
  private sequence = 0;
  private lastFrame = -Infinity;
  private lastAdapt = -Infinity;
  private settings = captureSettings(false);
  private pressure = new CapturePressure();
  private viewport: () => { width: number; height: number };
  private adapting = false;
  private closed = false;
  private generation = 0;
  constructor(
    cdp: BrowserCdp,
    now: () => number,
    onFrame: (frame: BrowserFrame, epoch: number) => void,
    privacy: () => { epoch: number; since: number } = () => ({ epoch: 0, since: -Infinity }),
    viewport: () => { width: number; height: number } = () => ({ width: 1280, height: 720 }),
  ) {
    this.cdp = cdp;
    this.now = now;
    this.onFrame = onFrame;
    this.privacy = privacy;
    this.viewport = viewport;
  }
  private receive: (raw: unknown) => void = () => {};
  private captureFrame(raw: unknown, cdp: BrowserCdp, generation: number): void {
    const ack = Ack.safeParse(raw);
    if (ack.success) void cdp.send("Page.screencastFrameAck", ack.data).catch(() => {});
    const parsed = Screencast.safeParse(raw);
    if (!parsed.success || this.closed || generation !== this.generation) return;
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
    const privacy = this.privacy(),
      capturedAt = parsed.data.metadata.timestamp;
    // CDP timestamps identify capture time, not delivery time. Missing provenance after
    // a private transition is fail-closed for recording, while human viewers still see frames.
    if (privacy.epoch === 0 || (capturedAt !== undefined && capturedAt * 1000 > privacy.since))
      this.onFrame(frame, privacy.epoch);
  }
  async start(): Promise<void> {
    if (this.closed) throw new Error("Browser capture closed");
    const cdp = this.cdp,
      generation = this.generation;
    this.receive = (raw) => this.captureFrame(raw, cdp, generation);
    cdp.on("Page.screencastFrame", this.receive);
    await this.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: this.settings.quality,
      everyNthFrame: this.settings.everyNthFrame,
      maxWidth: this.settings.maxWidth,
      maxHeight: this.settings.maxHeight,
    });
    if (this.closed || generation !== this.generation) throw new Error("Browser capture closed");
    // A static about:blank page may emit no screencast event. Seed the view so a
    // subscriber never has to wait for the first user/agent action to see pixels.
    const sequence = this.sequence,
      epoch = this.privacy().epoch;
    const viewport = this.viewport();
    const ratio = z
      .object({ result: z.object({ value: z.number().positive().finite() }) })
      .safeParse(
        await this.cdp.send("Runtime.evaluate", {
          expression: "window.devicePixelRatio",
          returnByValue: true,
        }),
      );
    const dpr = ratio.success ? ratio.data.result.value : 1;
    const initial = z.object({ data: z.string().max(4 * 1024 * 1024) }).parse(
      await this.cdp.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: this.settings.quality,
        clip: {
          x: 0,
          y: 0,
          ...viewport,
          scale: Math.min(
            1,
            this.settings.maxWidth / (viewport.width * dpr),
            this.settings.maxHeight / (viewport.height * dpr),
          ),
        },
      }),
    );
    if (this.closed || generation !== this.generation) throw new Error("Browser capture closed");
    if (this.sequence === sequence) {
      const frame: BrowserFrame = {
        sequence: ++this.sequence,
        timestamp: this.now(),
        data: initial.data,
        ...viewport,
      };
      this.fanout.publish(frame);
      if (epoch === this.privacy().epoch) this.onFrame(frame, epoch);
    }
    this.timer = setInterval(() => {
      this.fanout.flush();
      const now = this.now();
      const pressured = this.pressure.sample(this.fanout.pressured, now);
      const settings = captureSettings(pressured, this.fanout.captureViewers);
      if (
        this.closed ||
        this.adapting ||
        JSON.stringify(settings) === JSON.stringify(this.settings) ||
        this.now() - this.lastAdapt < 2000
      )
        return;
      this.lastAdapt = this.now();
      this.adapting = true;
      void (async () => {
        await cdp.send("Page.stopScreencast");
        if (!this.closed && generation === this.generation) {
          await cdp.send("Page.startScreencast", {
            format: "jpeg",
            quality: settings.quality,
            everyNthFrame: settings.everyNthFrame,
            maxWidth: settings.maxWidth,
            maxHeight: settings.maxHeight,
          });
          this.settings = settings;
        }
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
    this.generation++;
    clearInterval(this.timer);
    this.cdp.off("Page.screencastFrame", this.receive);
    this.fanout.invalidate();
  }
  async replace(cdp: BrowserCdp): Promise<void> {
    const previous = this.cdp;
    this.detach();
    await previous.send("Page.stopScreencast").catch(() => {});
    this.cdp = cdp;
    this.closed = false;
    this.lastFrame = -Infinity;
    this.pressure = new CapturePressure();
    this.settings = captureSettings(false, this.fanout.captureViewers);
    await this.start();
  }
  async close(): Promise<void> {
    this.closed = true;
    this.generation++;
    clearInterval(this.timer);
    this.cdp.off("Page.screencastFrame", this.receive);
    this.fanout.clear();
    await this.cdp.send("Page.stopScreencast").catch(() => {});
  }
}
