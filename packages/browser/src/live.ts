import { z } from "zod";
import type { BrowserCdp } from "./backend.ts";
import type { BrowserFrame } from "@ace/protocol";
import { Screencast } from "./cdp.ts";
import { FrameFanout, type CaptureViewer, type FrameSink } from "./fanout.ts";
import { captureSettings, CapturePressure, sameEncoding } from "./capture-policy.ts";
import { LiveVideo, type LiveVideoSource } from "./live-video.ts";

const Ack = z.object({ sessionId: z.number().int() });
/** How long capture keeps running after its last viewer leaves: a quick tab switch or a
 * reconnect resumes without restarting Chrome's screencast. */
const lingerMs = 5000;
/**
 * The thread's live view: the JPEG screencast every viewer can take (and recordings use), and
 * video for viewers that ask for it (ADR 0088). A video viewer gets JPEG frames until its first
 * keyframe, and again whenever its video stops. Chrome encodes every screencast frame, so the
 * screencast runs only while someone watches, a recording needs frames, or an agent works the
 * page; otherwise the page renders and throttles like any unseen tab.
 */
export class LiveCapture {
  readonly fanout = new FrameFanout();
  readonly video: LiveVideo;
  private sinks = new Map<string, FrameSink>();
  private videoSource: () => LiveVideoSource | undefined;
  private cdp: BrowserCdp;
  private now: () => number;
  private onFrame: (frame: BrowserFrame, epoch: number) => void;
  private privacy: () => { epoch: number; since: number };
  private timer: ReturnType<typeof setInterval> | undefined;
  private sequence = 0;
  private lastFrame = -Infinity;
  private lastAdapt = -Infinity;
  private settings = captureSettings(0);
  private pressure = new CapturePressure();
  private viewport: () => { width: number; height: number };
  private adapting = false;
  private tab: () => string | undefined;
  private scale: () => number;
  private closed = false;
  private generation = 0;
  /** Started by the session: capture may run. */
  private attached = false;
  /** Chrome is screencasting for this capture now. */
  private streaming = false;
  private linger: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private needed: () => boolean = () => false;
  /** `start` seeds after its own first sync; a later resume seeds in `begin`. */
  private starting = false;
  constructor(
    cdp: BrowserCdp,
    now: () => number,
    onFrame: (frame: BrowserFrame, epoch: number) => void,
    privacy: () => { epoch: number; since: number } = () => ({ epoch: 0, since: -Infinity }),
    viewport: () => { width: number; height: number } = () => ({ width: 1280, height: 720 }),
    tab: () => string | undefined = () => undefined,
    /**
     * How many window pixels stand for one CSS pixel of the captured tab: above 1 while the page
     * renders sharper than the browser's own scale (`headless-size.ts`). Frames report CSS size.
     */
    scale: () => number = () => 1,
    /** The shown tab's video encoder; absent where the backend has none (JPEG only). */
    videoSource: () => LiveVideoSource | undefined = () => undefined,
  ) {
    this.videoSource = videoSource;
    this.video = new LiveVideo({
      now,
      playing: (id, playing) => this.fanout.pause(id, playing),
    });
    this.tab = tab;
    this.scale = scale;
    this.cdp = cdp;
    this.now = now;
    this.onFrame = onFrame;
    this.privacy = privacy;
    this.viewport = viewport;
    this.fanout.watch(() => this.demand());
  }
  /** Frames are also needed while this holds (a recording), viewers or not. */
  require(needed: () => boolean): void {
    this.needed = needed;
    this.demand();
  }
  /** Re-evaluate whether to capture: now when frames are wanted, after a linger when not. */
  demand(): void {
    if (this.closed || !this.attached) return;
    clearTimeout(this.linger);
    this.linger = undefined;
    if (this.wanted()) {
      void this.sync().catch(() => {});
      return;
    }
    if (!this.streaming) return;
    this.linger = setTimeout(() => {
      this.linger = undefined;
      void this.sync().catch(() => {});
    }, lingerMs);
    this.linger.unref();
  }
  private wanted(): boolean {
    return this.fanout.watched || this.needed() || this.holds > 0;
  }
  private holds = 0;
  /**
   * Frames are wanted while `run` works. A headless page nobody watches draws no frames, and
   * an agent's clicks, scrolls and hit tests wait on them. The screencast is running before
   * `run` starts and lingers after it, so back-to-back commands keep one screencast.
   */
  async during<T>(run: () => Promise<T>): Promise<T> {
    this.holds++;
    try {
      if (!this.streaming) await this.sync().catch(() => {});
      return await run();
    } finally {
      this.holds--;
      this.demand();
    }
  }
  /** One begin or pause at a time, so a fast join and leave settle in order. */
  private sync(): Promise<void> {
    const run = this.queue.then(() => this.apply());
    this.queue = run.catch(() => {});
    return run;
  }
  private async apply(): Promise<void> {
    if (this.closed || !this.attached) return;
    const wanted = this.wanted();
    if (wanted && !this.streaming)
      try {
        await this.begin();
      } catch (error) {
        this.streaming = false;
        throw error;
      }
    else if (!wanted && this.streaming) await this.pause();
  }
  /** Chrome stops encoding; the listener stays, so a resumed screencast needs no rewiring. */
  private async pause(): Promise<void> {
    this.streaming = false;
    clearInterval(this.timer);
    await this.cdp.send("Page.stopScreencast").catch(() => {});
  }
  /** A viewer of the page: JPEG frames, plus video when it asked and its sink takes it. */
  subscribe(id: string, sink: FrameSink, capture?: CaptureViewer): () => void {
    const stop = this.fanout.subscribe(id, sink, capture);
    this.sinks.set(id, sink);
    this.video.remove(id);
    if (capture) this.configureVideo(id, sink, capture);
    return () => {
      stop();
      if (this.sinks.get(id) !== sink) return;
      this.sinks.delete(id);
      this.video.remove(id);
    };
  }
  /** What a viewer shows changed (`browser.capture`). */
  configure(id: string, capture: CaptureViewer): void {
    this.fanout.configure(id, capture);
    const sink = this.sinks.get(id);
    if (sink) this.configureVideo(id, sink, capture);
  }
  private configureVideo(id: string, sink: FrameSink, capture: CaptureViewer): void {
    if (sink.video && capture.video) {
      if (this.video.has(id)) this.video.configure(id, capture);
      else this.video.add(id, sink.video, capture, sink.audio);
    } else this.video.remove(id);
  }
  private receive: (raw: unknown) => void = () => {};
  /** The tab this capture shows, fixed when the capture starts on its page. */
  private capturing: string | undefined;
  private tabField(): { tabId?: string } {
    return this.capturing ? { tabId: this.capturing } : {};
  }
  private captureFrame(raw: unknown, cdp: BrowserCdp, generation: number): void {
    const ack = Ack.safeParse(raw);
    if (ack.success) void cdp.send("Page.screencastFrameAck", ack.data).catch(() => {});
    const parsed = Screencast.safeParse(raw);
    if (!parsed.success || this.closed || generation !== this.generation) return;
    const timestamp = this.now();
    if (timestamp - this.lastFrame < 1000 / this.settings.fps) return;
    this.lastFrame = timestamp;
    // Input coordinates are CSS pixels, so a frame reports the page's CSS size.
    const scale = this.scale();
    const frame: BrowserFrame = {
      sequence: ++this.sequence,
      timestamp,
      data: parsed.data.data,
      width: Math.round(parsed.data.metadata.deviceWidth / scale),
      height: Math.round(parsed.data.metadata.deviceHeight / scale),
      ...this.tabField(),
    };
    this.fanout.publish(frame);
    const privacy = this.privacy(),
      capturedAt = parsed.data.metadata.timestamp;
    // CDP timestamps identify capture time, not delivery time. Missing provenance after
    // a private transition is fail-closed for recording, while human viewers still see frames.
    if (privacy.epoch === 0 || (capturedAt !== undefined && capturedAt * 1000 > privacy.since))
      this.onFrame(frame, privacy.epoch);
  }
  /**
   * Attach to the page and seed its first frame, so every viewer that joins gets pixels at
   * once. Chrome's screencast itself runs only while frames are wanted (`demand`).
   */
  async start(): Promise<void> {
    if (this.closed) throw new Error("Browser capture closed");
    this.capturing = this.tab();
    const cdp = this.cdp,
      generation = this.generation;
    this.receive = (raw) => this.captureFrame(raw, cdp, generation);
    cdp.on("Page.screencastFrame", this.receive);
    this.attached = true;
    this.starting = true;
    try {
      await this.sync();
    } finally {
      this.starting = false;
    }
    const { viewport, dpr } = await this.seed(generation);
    this.video.attach(this.videoSource(), this.capturing, { ...viewport, scale: dpr });
  }
  /**
   * A static about:blank page may emit no screencast event. Seed the view so a subscriber
   * never has to wait for the first user/agent action to see pixels.
   */
  private async seed(
    generation: number,
  ): Promise<{ viewport: { width: number; height: number }; dpr: number }> {
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
        ...this.tabField(),
      };
      this.fanout.publish(frame);
      if (epoch === this.privacy().epoch) this.onFrame(frame, epoch);
    }
    return { viewport, dpr };
  }
  private async begin(): Promise<void> {
    if (this.closed) throw new Error("Browser capture closed");
    this.streaming = true;
    // Sized for the viewers watching now, which may have joined since the last screencast.
    this.settings = captureSettings(0, this.fanout.captureViewers);
    const cdp = this.cdp,
      generation = this.generation;
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: this.settings.quality,
      everyNthFrame: this.settings.everyNthFrame,
      maxWidth: this.settings.maxWidth,
      maxHeight: this.settings.maxHeight,
    });
    if (this.closed || generation !== this.generation) throw new Error("Browser capture closed");
    this.timer = setInterval(() => {
      this.fanout.flush();
      if (!this.closed) this.video.tick(this.viewport());
      const now = this.now();
      const load = this.pressure.sample(this.fanout.pressured, now);
      const settings = captureSettings(load, this.fanout.captureViewers);
      if (this.closed || this.adapting) return;
      // The frame rate is applied here, as frames arrive: changing it alone needs no restart.
      if (sameEncoding(settings, this.settings)) {
        this.settings = settings;
        return;
      }
      if (now - this.lastAdapt < 1000) return;
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
    // Resuming after a pause: the page may have changed while nothing was captured.
    if (!this.starting) await this.seed(generation);
  }
  detach(): void {
    this.closed = true;
    this.streaming = false;
    this.generation++;
    clearInterval(this.timer);
    clearTimeout(this.linger);
    this.cdp.off("Page.screencastFrame", this.receive);
    this.video.detach();
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
    this.settings = captureSettings(0, this.fanout.captureViewers);
    await this.start();
  }
  async close(): Promise<void> {
    this.closed = true;
    this.streaming = false;
    this.attached = false;
    this.generation++;
    clearInterval(this.timer);
    clearTimeout(this.linger);
    this.cdp.off("Page.screencastFrame", this.receive);
    this.video.clear();
    this.sinks.clear();
    this.fanout.clear();
    await this.cdp.send("Page.stopScreencast").catch(() => {});
  }
}
