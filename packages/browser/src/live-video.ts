import type { BrowserVideoStatus, MediaAcceleration } from "@ace/protocol";
import { listens } from "./audio-fanout.ts";
import type { BrowserCdp, VideoCaptureHandle, VideoEncode, VideoHost } from "./backend.ts";
import { longestFrameSide, type CaptureViewer } from "./capture-policy.ts";
import { mediaKey } from "./encode-ids.ts";

/*
 * One thread's live video (ADR 0088, ADR 0147): which views ace-media delivers, the tab capture
 * that feeds it and the encodes it runs. ace-media plans, paces and sends every view itself
 * (`source.want`, D1); the daemon sends viewers nothing (X3). The live capture ticks it every
 * 100 ms and tells it which tab it shows; this holds the state between the views, ace-media's
 * plan and the browser's encoder.
 */

/** Where the shown tab's video comes from: absent for a backend without an encoder. */
export interface LiveVideoSource {
  host: VideoHost;
  page: BrowserCdp;
}

/** The codec of an encode key: `codec/WxH`, or ace-media's `media/<id>/codec/WxH`. */
function encodeCodec(key: string): string | undefined {
  const parts = key.split("/");
  return key.startsWith(mediaKey) ? parts[2] : parts[0];
}
/** Codecs asked of the encoder, whatever viewers prefer; a viewer's order picks among them. */
const knownCodecs = ["hvc1.1.6.L153.B0", "avc1.640033", "avc1.42E033", "vp09.00.41.08", "vp8"];
/** A capture size change waits for the pane to stop moving. */
const settleMs = 300;
/**
 * After a capture failed before its first chunk (the encoder failed to start, or the capture
 * ended without a picture), try again this much later, doubling with each failure in a row up
 * to `maxRetryMs`.
 */
const retryMs = 5_000;
const maxRetryMs = 60_000;
/** A live view runs at this rate while its link carries it (ADR 0088 amendment, ADR 0149). */
const videoFps = 60;
/**
 * The first encode's bit rate, before ace-media has a plan: a viewer elsewhere starts here, one
 * on this machine at the top rate (loopback carries any rate). ace-media's plan replaces it.
 */
const firstBitrate = 1_500_000;
const localBitrate = 16_000_000;

const even = (value: number) => Math.max(2, 2 * Math.round(value / 2));

/** The picture a view needs: the page at the size its pane shows it, in device pixels. */
function viewPicture(
  page: { width: number; height: number; scale: number },
  viewport: CaptureViewer["viewport"],
): { width: number; height: number } {
  const shown = Math.min(viewport.width / page.width, viewport.height / page.height);
  const scale = Math.min(
    shown * viewport.devicePixelRatio,
    page.scale,
    longestFrameSide / Math.max(page.width, page.height),
  );
  return { width: even(page.width * scale), height: even(page.height * scale) };
}

/**
 * The one encode a capture runs before ace-media's plan comes, so ace-media sees the source
 * and plans its views: the largest picture any of them needs, in the first codec the encoder
 * runs that one of them decodes. Undefined when no view decodes anything the encoder runs.
 */
export function firstEncode(
  page: { width: number; height: number; scale: number },
  views: readonly { viewport: CaptureViewer["viewport"]; codecs: readonly string[] }[],
  runnable: readonly string[],
  local: boolean,
): VideoEncode | undefined {
  const shown = views.filter((view) => view.viewport.nativeShown !== true);
  const codec = runnable.find((candidate) => shown.some((view) => view.codecs.includes(candidate)));
  if (!codec) return undefined;
  const size = { width: 0, height: 0 };
  for (const view of shown) {
    const picture = viewPicture(page, view.viewport);
    size.width = Math.max(size.width, picture.width);
    size.height = Math.max(size.height, picture.height);
  }
  return {
    key: `${codec}/${size.width}x${size.height}`,
    codec,
    width: size.width,
    height: size.height,
    fps: videoFps,
    bitrate: local ? localBitrate : firstBitrate,
  };
}

interface Viewer {
  capture: CaptureViewer;
  local: boolean;
}

interface Capture {
  handle: VideoCaptureHandle;
  width: number;
  height: number;
}

export class LiveVideo {
  private now: () => number;
  private viewers = new Map<string, Viewer>();
  private source: LiveVideoSource | undefined;
  private tabId: string | undefined;
  private page = { width: 1280, height: 720, scale: 1 };
  private codecs: string[] | undefined;
  private failedCodecs = new Set<string>();
  /** The codecs last told to the open capture (`VideoCaptureHandle.codecs`), joined. */
  private told = "";
  private capture: Capture | undefined;
  private opening = false;
  private retryAt = -Infinity;
  private wanted: { width: number; height: number; since: number } | undefined;
  private encodes = "";
  /** ace-media's plan for the views it delivers (D1), from the open capture; none yet. */
  private mediaWanted: VideoEncode[] | undefined;
  private generation = 0;
  /** What the open capture was last told about its sound (a capture starts with it off). */
  private soundOn = false;
  /** Captures in a row that failed before their first chunk, and why the last one did. */
  private failures = 0;
  private failure = "";
  private statusChanged: () => void;
  constructor(options: {
    now: () => number;
    /** `status()` changed. */
    statusChanged?(): void;
  }) {
    this.now = options.now;
    this.statusChanged = options.statusChanged ?? (() => {});
  }
  /**
   * A view ace-media delivers, or its new pane. A view it doesn't deliver (a client without a
   * media connection) takes no part: nothing here sends pictures. `local`: the viewer is on this
   * machine, so the first encode starts at the top rate.
   */
  add(id: string, capture: CaptureViewer, link: { local?: boolean } = {}): void {
    if (!capture.video || capture.delivered !== true) return this.remove(id);
    this.viewers.set(id, { capture, local: link.local === true });
  }
  configure(id: string, capture: CaptureViewer): void {
    const viewer = this.viewers.get(id);
    if (!viewer) return;
    if (!capture.video || capture.delivered !== true) return this.remove(id);
    viewer.capture = capture;
  }
  remove(id: string): void {
    this.viewers.delete(id);
  }
  has(id: string): boolean {
    return this.viewers.has(id);
  }
  /** Someone is shown this video now: a paused (hidden) view doesn't count. */
  watched(): boolean {
    return this.showing().length > 0;
  }
  private showing(): [string, Viewer][] {
    return [...this.viewers].filter(([, viewer]) => !paused(viewer.capture));
  }
  /** The screencast size an open capture fed by pictures needs; undefined: none needed. */
  pictures(): { width: number; height: number } | undefined {
    const pictures = this.capture?.handle.pictures;
    return pictures ? { width: pictures.width, height: pictures.height } : undefined;
  }
  /** One screencast frame for a capture fed by pictures. */
  picture(base64: string): void {
    this.capture?.handle.pictures?.push(base64);
  }
  /** The capture shows this tab now (or nothing, without a source). */
  attach(
    source: LiveVideoSource | undefined,
    tabId: string | undefined,
    page: { width: number; height: number; scale: number },
  ): void {
    this.detach();
    this.source = source;
    this.tabId = tabId;
    this.page = page;
    this.retryAt = -Infinity;
    // Another tab starts afresh.
    this.recovered();
  }
  /** Set while the video can't start and is being retried; undefined while it plays. */
  status(): BrowserVideoStatus | undefined {
    if (!this.failures) return undefined;
    return { status: "retrying", reason: this.failure, attempts: this.failures };
  }
  /** What ace-media runs the video on while it carries it (`BrowserState.acceleration`). */
  acceleration(): MediaAcceleration | undefined {
    return this.capture?.handle.acceleration?.();
  }
  /** Stops the tab's capture. */
  detach(): void {
    this.close();
    this.source = undefined;
    this.wanted = undefined;
  }
  clear(): void {
    this.detach();
    this.viewers.clear();
  }
  /**
   * The page it shows is being restored (shown again, thawed or reopened): the capture stops,
   * and no capture opens until `resume`. The first unit after is a keyframe of a new capture.
   */
  hold(): void {
    if (this.held) return;
    this.held = true;
    this.close();
  }
  /** The page is back: the next tick opens a capture of it. */
  resume(): void {
    this.held = false;
  }
  private held = false;
  /** Opens, resizes or closes the capture for the views shown now; `page` is the page's CSS size. */
  tick(page: { width: number; height: number }): void {
    if (this.held) return;
    const now = this.now();
    this.page = { ...this.page, ...page };
    const source = this.source;
    const showing = this.showing();
    if (!source || !showing.length) {
      if (this.capture) this.close();
      return;
    }
    if (this.codecs === undefined) return this.probe(source, now);
    const runnable = this.runnable();
    // ace-media's plan once it has one; until then one encode, so it sees the source.
    const first = firstEncode(
      this.page,
      showing.map(([, viewer]) => ({
        viewport: viewer.capture.viewport,
        codecs: viewer.capture.video?.codecs ?? [],
      })),
      runnable,
      showing.some(([, viewer]) => viewer.local),
    );
    const encodes = this.mediaWanted ?? (first ? [first] : []);
    if (!encodes.length) {
      if (this.capture) this.close();
      return;
    }
    // The capture is as large as the largest encode; encoders scale it down themselves.
    const size = {
      width: Math.max(...encodes.map((encode) => encode.width)),
      height: Math.max(...encodes.map((encode) => encode.height)),
    };
    const capture = this.capture;
    if (!capture || capture.width !== size.width || capture.height !== size.height) {
      if (!this.wanted || this.wanted.width !== size.width || this.wanted.height !== size.height)
        this.wanted = { ...size, since: now };
      // The first capture opens at once; a resize waits for the pane to settle.
      if (!capture || now - this.wanted.since >= settleMs) this.open(source, size, now);
    }
    const open = this.capture;
    if (!open) return;
    if (runnable.join(",") !== this.told) {
      this.told = runnable.join(",");
      open.handle.codecs?.(runnable);
    }
    const planned = encodes
      .map((encode) => `${encode.key}@${encode.fps}/${encode.bitrate}`)
      .join(",");
    if (planned !== this.encodes) {
      this.encodes = planned;
      open.handle.encodes(encodes);
    }
    // The tab's sound is encoded only while a view listens: a muted viewer costs nothing.
    const sound = showing.some(([, viewer]) => listens(viewer.capture));
    if (sound !== this.soundOn) {
      this.soundOn = sound;
      open.handle.audio?.(sound);
    }
  }
  /** The codecs the encoder supports here, less those that failed. */
  private runnable(): string[] {
    return (this.codecs ?? []).filter((codec) => !this.failedCodecs.has(codec));
  }
  private probe(source: LiveVideoSource, now: number): void {
    if (this.opening || now < this.retryAt) return;
    this.opening = true;
    const generation = this.generation;
    void source.host
      .supported(knownCodecs, this.page.width, this.page.height)
      .then(
        (codecs) => {
          this.codecs = codecs;
        },
        () => {
          // No encoder yet (the extension failed to load): it is retried.
          if (generation === this.generation) this.retryAt = this.now() + retryMs;
        },
      )
      .finally(() => {
        this.opening = false;
      });
  }
  private open(source: LiveVideoSource, size: { width: number; height: number }, now: number) {
    if (this.opening || now < this.retryAt) return;
    this.opening = true;
    this.close();
    const generation = this.generation;
    let played = false;
    const playing = () => {
      if (played || generation !== this.generation) return;
      played = true;
      this.recovered();
    };
    void source.host
      .open(source.page, size.width, size.height, {
        // Units on the daemon's path go nowhere: ace-media delivers every view.
        chunk: () => playing(),
        failed: (encode) => {
          const codec = encodeCodec(encode);
          if (codec && generation === this.generation) this.failedCodecs.add(codec);
        },
        want: (encodes) => {
          if (generation !== this.generation) return;
          this.mediaWanted = encodes && [...encodes];
          // ace-media plans once it has the source's pictures: the capture plays.
          if (encodes?.length) playing();
        },
        accelerated: () => {
          if (generation === this.generation) this.statusChanged();
        },
        ended: (reason) => {
          if (generation !== this.generation) return;
          this.capture = undefined;
          this.encodes = "";
          this.mediaWanted = undefined;
          this.soundOn = false;
          // Reopening at once would loop on a tab that never gives a picture.
          if (!played) this.failed(reason ?? "The tab's capture ended before its first picture");
        },
      })
      .then(
        (handle) => {
          if (generation !== this.generation) return handle.close();
          this.capture = { handle, ...size };
          this.encodes = "";
          this.told = "";
          this.soundOn = false;
        },
        (error: unknown) => {
          if (generation !== this.generation) return;
          this.failed(error instanceof Error ? error.message : "The tab's capture did not start");
        },
      )
      .finally(() => {
        this.opening = false;
      });
  }
  /** A capture failed before its first chunk: the next waits longer, and viewers are told. */
  private failed(reason: string): void {
    this.failures++;
    this.failure = reason.slice(0, 2048);
    this.retryAt = this.now() + Math.min(retryMs * 2 ** (this.failures - 1), maxRetryMs);
    this.statusChanged();
  }
  /** Video plays (or another tab starts): failures so far no longer count. */
  private recovered(): void {
    if (!this.failures) return;
    this.failures = 0;
    this.failure = "";
    this.statusChanged();
  }
  private close(): void {
    this.generation++;
    this.capture?.handle.close();
    this.capture = undefined;
    this.encodes = "";
    this.mediaWanted = undefined;
    this.soundOn = false;
  }
}

/** The view is hidden or backgrounded (ADR 0149): it takes no video and no sound. */
function paused(capture: CaptureViewer): boolean {
  return capture.viewport.paused === true;
}
