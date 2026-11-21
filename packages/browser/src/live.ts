import { readGapMs } from "@ace/media/epochs";
import { z } from "zod";
import type { BrowserCdp } from "./backend.ts";
import type { BrowserFrame } from "@ace/protocol";
import { Screencast } from "./cdp.ts";
import type { CaptureViewer, ViewerSink } from "./viewer-sink.ts";
import { screencastSettings } from "./capture-policy.ts";
import { LiveVideo, type LiveVideoSource } from "./live-video.ts";

const DevicePixelRatio = z.object({ result: z.object({ value: z.number().positive().finite() }) });
const InitialFrame = z.object({ data: z.string().max(4 * 1024 * 1024) });

const Ack = z.object({ sessionId: z.number().int() });
/** How long the screencast keeps running after it was last needed: back-to-back agent commands
 * keep one screencast. */
const lingerMs = 5000;
/** How often the live video re-plans its encodes and retries chunks a transport refused. */
const videoTickMs = 50;
/** The scale of the screenshot that proves a page draws, when nothing records it. */
const probeScale = 0.05;
/** The largest screencast a capture fed by pictures takes, on its long side. */
const picturesLongSide = 1920;
/**
 * The thread's live view (ADR 0088, amended). Viewers get encoded video only, never JPEG. The
 * JPEG screencast is internal: it feeds recordings and keeps a headless page drawing while an
 * agent works it (its clicks and hit tests wait on frames). Chrome encodes every screencast
 * frame, so it runs only while a recording or an agent needs it.
 */
/** The shown tab's privacy (`TabAccess`): its epoch, when it last changed, and whether it is private now. */
export type Privacy = { epoch: number; since: number; private?: boolean };

/**
 * The epoch a picture captured at `at` (ms) belongs to: the current one, except within the
 * read gap after the tab stopped being private, when it is the private one before it.
 */
export function capturedEpoch(privacy: Privacy, at: number): number {
  return privacy.private !== true && privacy.epoch > 0 && at < privacy.since + readGapMs
    ? privacy.epoch - 1
    : privacy.epoch;
}

export class LiveCapture {
  readonly video: LiveVideo;
  private sinks = new Map<string, ViewerSink>();
  private videoSource: () => LiveVideoSource | undefined;
  private cdp: BrowserCdp;
  private now: () => number;
  private onFrame: (frame: BrowserFrame, epoch: number, capturedAt: number) => void;
  /** The privacy of a tab by id (undefined: the one page a backend without tabs shows). */
  private privacy: (tabId: string | undefined) => Privacy;
  private videoTimer: ReturnType<typeof setInterval> | undefined;
  private sequence = 0;
  private lastFrame = -Infinity;
  private settings = screencastSettings;
  private viewport: () => { width: number; height: number };
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
  private videoStatus: () => void = () => {};
  private watchListener: (watched: boolean) => void = () => {};
  /** `start` seeds after its own first sync; a later resume seeds in `begin`. */
  private starting = false;
  constructor(
    cdp: BrowserCdp,
    now: () => number,
    /** A picture of the captured tab, with the epoch and the time it was captured in. */
    onFrame: (frame: BrowserFrame, epoch: number, capturedAt: number) => void,
    privacy: (tabId: string | undefined) => Privacy = () => ({
      epoch: 0,
      since: -Infinity,
      private: false,
    }),
    viewport: () => { width: number; height: number } = () => ({ width: 1280, height: 720 }),
    tab: () => string | undefined = () => undefined,
    /**
     * How many window pixels stand for one CSS pixel of the captured tab: above 1 while the page
     * renders sharper than the browser's own scale (`headless-size.ts`). Frames report CSS size.
     */
    scale: () => number = () => 1,
    /** The shown tab's video encoder; absent where the backend has none (no pictures). */
    videoSource: () => LiveVideoSource | undefined = () => undefined,
  ) {
    this.videoSource = videoSource;
    this.video = new LiveVideo({ now, statusChanged: () => this.videoStatus() });
    this.tab = tab;
    this.scale = scale;
    this.cdp = cdp;
    this.now = now;
    this.onFrame = onFrame;
    this.privacy = privacy;
    this.viewport = viewport;
  }
  /** Told whenever `video.status()` changes (the video can't start, or plays again). */
  onVideoStatus(listener: () => void): void {
    this.videoStatus = listener;
  }
  /** Told when the first viewer starts watching the video, and when the last one stops. */
  onWatched(listener: (watched: boolean) => void): void {
    this.watchListener = listener;
  }
  /** Someone is shown the live video now. */
  watched(): boolean {
    return this.video.watched();
  }
  /** Runs a change to the video's viewers, and says if that started or ended all watching. */
  private viewersChange(change: () => void): void {
    const before = this.video.watched();
    change();
    const after = this.video.watched();
    if (before !== after) this.watchListener(after);
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
    return this.needed() || this.holds > 0 || this.video.pictures() !== undefined;
  }
  /**
   * The screencast's settings: larger while it feeds a video capture, up to what Chrome can
   * JPEG-encode 60 times a second (1920 px on the long side, quality 80).
   */
  private screencast() {
    const pictures = this.video.pictures();
    if (!pictures) return screencastSettings;
    const fit = Math.min(1, picturesLongSide / Math.max(pictures.width, pictures.height));
    return {
      ...screencastSettings,
      quality: 80,
      maxWidth: Math.round(pictures.width * fit),
      maxHeight: Math.round(pictures.height * fit),
    };
  }
  /** What the running screencast was started for, to restart it when that changes. */
  private screencastKey = "";
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
    await this.cdp.send("Page.stopScreencast").catch(() => {});
  }
  /** A viewer of the page: video, once it says what it shows and which codecs it decodes. */
  subscribe(id: string, sink: ViewerSink, capture?: CaptureViewer): () => void {
    if (!this.sinks.has(id) && this.sinks.size >= 64) throw new Error("Browser subscriber limit");
    this.sinks.set(id, sink);
    this.viewersChange(() => {
      this.video.remove(id);
      if (capture) this.configureVideo(id, sink, capture);
    });
    this.tickVideo();
    return () => {
      if (this.sinks.get(id) !== sink) return;
      this.sinks.delete(id);
      this.viewersChange(() => this.video.remove(id));
      this.tickVideo();
    };
  }
  /** What a viewer shows changed (`browser.capture`). */
  configure(id: string, capture: CaptureViewer): void {
    const sink = this.sinks.get(id);
    if (sink) this.viewersChange(() => this.configureVideo(id, sink, capture));
  }
  /** The live video runs its own clock while anyone watches, screencast or not. */
  private tickVideo(): void {
    const run = this.attached && !this.closed && this.sinks.size > 0;
    if (run && !this.videoTimer) {
      this.videoTimer = setInterval(() => this.stepVideo(), videoTickMs);
      this.videoTimer.unref();
    } else if (!run && this.videoTimer) {
      this.stopVideoClock();
      this.stepVideo();
    }
  }
  /** One video step; a page that went away meanwhile skips it rather than throw in a timer. */
  /**
   * The shown page is about to be restored (shown again, thawed or reopened): no video is
   * captured or delivered until `resumeVideo`, so a viewer never gets a hidden or stale picture.
   */
  holdVideo(): void {
    this.video.hold();
  }
  /** The shown page is back; video starts again at a fresh keyframe. */
  resumeVideo(): void {
    this.video.resume();
  }
  private stepVideo(): void {
    let viewport: { width: number; height: number };
    try {
      viewport = this.viewport();
    } catch {
      return;
    }
    this.video.tick(viewport);
    // A capture fed by pictures needs the screencast, at its size.
    const pictures = this.video.pictures();
    const key = pictures ? `${pictures.width}x${pictures.height}` : "";
    if (key === this.screencastKey) return;
    this.screencastKey = key;
    if (this.streaming) void this.restart().catch(() => {});
    else this.demand();
  }
  /** Starts the screencast again with what it is needed for now. */
  private async restart(): Promise<void> {
    const run = this.queue.then(async () => {
      if (!this.streaming) return;
      await this.cdp.send("Page.stopScreencast").catch(() => {});
      this.streaming = false;
      if (this.wanted()) await this.begin();
    });
    this.queue = run.catch(() => {});
    await run;
    this.demand();
  }
  private configureVideo(id: string, sink: ViewerSink, capture: CaptureViewer): void {
    if (this.video.has(id)) this.video.configure(id, capture);
    else this.video.add(id, capture, { local: sink.local === true });
  }
  private receive: (raw: unknown) => void = () => {};
  /** The tab this capture shows, fixed when the capture starts on its page. */
  private capturing: string | undefined;
  private tabField(): { tabId?: string } {
    return this.capturing ? { tabId: this.capturing } : {};
  }
  /**
   * The privacy of the tab this capture shows: its pictures carry that tab's content, whichever
   * tab is viewed by the time they arrive.
   */
  private tabPrivacy(): Privacy {
    return this.privacy(this.capturing);
  }
  /**
   * The person moved to another tab: this capture's pictures are the old tab's from now on, and
   * none of them goes anywhere. Called as the view changes, before the capture moves.
   */
  retarget(): void {
    this.generation++;
  }
  private captureFrame(raw: unknown, cdp: BrowserCdp, generation: number): void {
    const ack = Ack.safeParse(raw);
    if (ack.success) void cdp.send("Page.screencastFrameAck", ack.data).catch(() => {});
    const parsed = Screencast.safeParse(raw);
    if (!parsed.success || this.closed || generation !== this.generation) return;
    const privacy = this.tabPrivacy(),
      capturedAt = parsed.data.metadata.timestamp;
    // CDP timestamps identify capture time, not delivery time: a picture captured before the
    // tab's last privacy change is dropped before it goes anywhere (the video, a still, a
    // recording). Missing provenance after a change is fail-closed.
    if (privacy.epoch !== 0 && (capturedAt === undefined || capturedAt * 1000 <= privacy.since))
      return;
    this.privacyChanged();
    // The epoch the picture was captured in goes with it, for ace-media's stills and encodes.
    // One captured within the read gap after the tab stopped being private keeps the private
    // epoch, as a video producer's stamper does: the page may still show what it hid.
    const epoch = capturedEpoch(privacy, (capturedAt ?? 0) * 1000);
    this.video.picture(parsed.data.data, epoch);
    const timestamp = this.now();
    if (timestamp - this.lastFrame < 1000 / this.settings.fps) return;
    this.lastFrame = timestamp;
    // A recording's frame reports the page's CSS size, like the input coordinates.
    const scale = this.scale();
    const frame: BrowserFrame = {
      sequence: ++this.sequence,
      timestamp,
      data: parsed.data.data,
      width: Math.round(parsed.data.metadata.deviceWidth / scale),
      height: Math.round(parsed.data.metadata.deviceHeight / scale),
      ...this.tabField(),
    };
    this.onFrame(frame, epoch, (capturedAt ?? 0) * 1000);
  }
  /**
   * The tab's privacy may have changed: the video hears its epoch once (M8), with whether the
   * one it replaces was private, so ace-media stamps and keeps pictures as it does video.
   */
  privacyChanged(): void {
    const privacy = this.tabPrivacy();
    this.video.privacy({ epoch: privacy.epoch, private: privacy.private === true });
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
    // The video knows the tab's privacy before its first capture opens, so it opens in it.
    this.privacyChanged();
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
    this.tickVideo();
  }
  /**
   * The page's size and scale, for the video, and one screenshot: proof the page can draw at
   * all (a desktop view on a locked screen never answers, and the open moves to another
   * backend), and while a recording runs its first frame, as a static page may emit no
   * screencast event. Without a recording the screenshot is a tiny one.
   */
  private async seed(
    generation: number,
  ): Promise<{ viewport: { width: number; height: number }; dpr: number }> {
    const sequence = this.sequence,
      privacy = this.tabPrivacy();
    const viewport = this.viewport();
    const ratio = DevicePixelRatio.safeParse(
      await this.cdp.send("Runtime.evaluate", {
        expression: "window.devicePixelRatio",
        returnByValue: true,
      }),
    );
    const dpr = ratio.success ? ratio.data.result.value : 1;
    const recording = this.needed();
    // The screenshot may show the page as it was when it was asked for: its capture time.
    const capturedAt = this.now();
    const initial = InitialFrame.parse(
      await this.cdp.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: this.settings.quality,
        clip: {
          x: 0,
          y: 0,
          ...viewport,
          scale: recording
            ? Math.min(
                1,
                this.settings.maxWidth / (viewport.width * dpr),
                this.settings.maxHeight / (viewport.height * dpr),
              )
            : probeScale,
        },
      }),
    );
    if (this.closed || generation !== this.generation) throw new Error("Browser capture closed");
    // A recording's first frame, fenced as every picture is: never from before the tab's last
    // privacy change, and within the read gap after it stopped being private it keeps the
    // private epoch, which nothing records.
    if (
      recording &&
      this.sequence === sequence &&
      privacy.epoch === this.tabPrivacy().epoch &&
      (privacy.epoch === 0 || capturedAt > privacy.since)
    )
      this.onFrame(
        {
          sequence: ++this.sequence,
          timestamp: this.now(),
          data: initial.data,
          ...viewport,
          ...this.tabField(),
        },
        capturedEpoch(privacy, capturedAt),
        capturedAt,
      );
    return { viewport, dpr };
  }
  private async begin(): Promise<void> {
    if (this.closed) throw new Error("Browser capture closed");
    this.streaming = true;
    this.settings = this.screencast();
    const generation = this.generation;
    await this.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: this.settings.quality,
      everyNthFrame: this.settings.everyNthFrame,
      maxWidth: this.settings.maxWidth,
      maxHeight: this.settings.maxHeight,
    });
    if (this.closed || generation !== this.generation) throw new Error("Browser capture closed");
    // Resuming after a pause: the page may have changed while nothing was captured.
    if (!this.starting) await this.seed(generation);
  }
  private stopVideoClock(): void {
    clearInterval(this.videoTimer);
    this.videoTimer = undefined;
  }
  detach(): void {
    this.closed = true;
    this.streaming = false;
    this.generation++;
    this.stopVideoClock();
    clearTimeout(this.linger);
    this.cdp.off("Page.screencastFrame", this.receive);
    this.video.detach();
  }
  async replace(cdp: BrowserCdp): Promise<void> {
    const previous = this.cdp;
    this.detach();
    await previous.send("Page.stopScreencast").catch(() => {});
    this.cdp = cdp;
    this.closed = false;
    // Another page (another tab, or a reopened browser's): nothing is being restored on it.
    this.video.resume();
    this.lastFrame = -Infinity;
    this.settings = screencastSettings;
    await this.start();
  }
  async close(): Promise<void> {
    this.closed = true;
    this.streaming = false;
    this.attached = false;
    this.generation++;
    this.stopVideoClock();
    clearTimeout(this.linger);
    this.cdp.off("Page.screencastFrame", this.receive);
    this.video.clear();
    this.sinks.clear();
    await this.cdp.send("Page.stopScreencast").catch(() => {});
  }
}
