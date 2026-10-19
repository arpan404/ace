import type { BrowserCdp, EncodedChunk, VideoCaptureHandle, VideoHost } from "./backend.ts";
import { CapturePressure } from "./capture-policy.ts";
import type { CaptureViewer } from "./capture-policy.ts";
import type { BrowserVideoChunk } from "./stream-video.ts";
import { VideoFanout, type VideoSink } from "./video-fanout.ts";
import { planVideo, type VideoEncode } from "./video-policy.ts";

/*
 * One thread's live video (ADR 0088): which viewers take video, the tab capture and its encodes,
 * and the chunks to each viewer. The live capture ticks it every 100 ms and tells it which tab it
 * shows; the plan and the drop rules are pure (`video-policy.ts`, `video-fanout.ts`), this holds
 * the state between them and the browser's encoder.
 */

/** Where the shown tab's video comes from: absent for a backend without an encoder. */
export interface LiveVideoSource {
  host: VideoHost;
  page: BrowserCdp;
}

/** Codecs asked of the encoder, whatever viewers prefer; a viewer's order picks among them. */
const knownCodecs = ["avc1.42E033", "vp09.00.41.08", "vp8"];
/** A capture size change waits for the pane to stop moving. */
const settleMs = 300;
/** After the encoder failed to start, try again this much later. */
const retryMs = 5_000;
/** A slower tier is its own encode; stepping back up costs a keyframe, so it isn't hurried. */
const recoveryMs = 3_000;

interface Viewer {
  capture: CaptureViewer;
  pressure: CapturePressure;
}

interface Capture {
  handle: VideoCaptureHandle;
  width: number;
  height: number;
}

export class LiveVideo {
  readonly fanout: VideoFanout<BrowserVideoChunk>;
  private now: () => number;
  private viewers = new Map<string, Viewer>();
  private source: LiveVideoSource | undefined;
  private tabId: string | undefined;
  private page = { width: 1280, height: 720, scale: 1 };
  private codecs: string[] | undefined;
  private failedCodecs = new Set<string>();
  private capture: Capture | undefined;
  private opening = false;
  private retryAt = -Infinity;
  private wanted: { width: number; height: number; since: number } | undefined;
  private encodes = "";
  private owedKeys = new Set<string>();
  private sequence = 0;
  private generation = 0;
  constructor(options: {
    now: () => number;
    /** A viewer started or stopped showing video: pause or resume its JPEG frames. */
    playing(id: string, playing: boolean): void;
  }) {
    this.now = options.now;
    this.fanout = new VideoFanout<BrowserVideoChunk>({
      keyframe: (encode) => this.owedKeys.add(encode),
      playing: options.playing,
    });
  }
  /** A viewer that asked for video, or its new pane. */
  add(id: string, sink: VideoSink<BrowserVideoChunk>, capture: CaptureViewer): void {
    if (!capture.video) return;
    if (!this.fanout.has(id)) this.fanout.add(id, sink);
    const existing = this.viewers.get(id);
    this.viewers.set(id, {
      capture,
      pressure: existing?.pressure ?? new CapturePressure(recoveryMs),
    });
  }
  configure(id: string, capture: CaptureViewer): void {
    const viewer = this.viewers.get(id);
    if (viewer) viewer.capture = capture;
  }
  remove(id: string): void {
    this.viewers.delete(id);
    this.fanout.remove(id);
  }
  has(id: string): boolean {
    return this.viewers.has(id);
  }
  acknowledge(id: string, sequence: number): void {
    this.fanout.acknowledge(id, sequence);
  }
  keyframe(id: string): void {
    this.fanout.keyframe(id);
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
  }
  /** Stops the tab's capture; viewers fall back to JPEG until the next `attach`. */
  detach(): void {
    this.generation++;
    this.capture?.handle.close();
    this.capture = undefined;
    this.source = undefined;
    this.encodes = "";
    this.wanted = undefined;
    this.owedKeys.clear();
    this.fanout.stopAll();
  }
  clear(): void {
    this.detach();
    this.fanout.clear();
    this.viewers.clear();
  }
  /** Samples load, re-plans the encodes and applies them. `page` is the page's CSS size now. */
  tick(page: { width: number; height: number }): void {
    const now = this.now();
    this.fanout.flush();
    this.page = { ...this.page, ...page };
    const source = this.source;
    if (!source || !this.viewers.size) {
      if (this.capture) this.close();
      return;
    }
    if (this.codecs === undefined) return this.probe(source, now);
    const plan = planVideo(
      {
        ...this.page,
        codecs: this.codecs.filter((codec) => !this.failedCodecs.has(codec)),
      },
      [...this.viewers].map(([id, viewer]) => ({
        id,
        viewport: viewer.capture.viewport,
        codecs: viewer.capture.video?.codecs ?? [],
        load: viewer.pressure.sample(this.fanout.backlogged(id), now),
      })),
    );
    if (!plan.encodes.length) {
      if (this.capture) this.close();
      return;
    }
    const size = largest(plan.encodes);
    const capture = this.capture;
    if (!capture || capture.width !== size.width || capture.height !== size.height) {
      if (!this.wanted || this.wanted.width !== size.width || this.wanted.height !== size.height)
        this.wanted = { ...size, since: now };
      // The first capture opens at once; a resize waits for the pane to settle.
      if (!capture || now - this.wanted.since >= settleMs) this.open(source, size, now);
    }
    const open = this.capture;
    for (const id of this.viewers.keys())
      this.fanout.assign(id, open ? plan.viewers.get(id) : undefined);
    if (!open) return;
    const encodes = plan.encodes.map((encode) => encode.key).join(",");
    if (encodes !== this.encodes) {
      this.encodes = encodes;
      open.handle.encodes(plan.encodes);
    }
    for (const key of this.owedKeys)
      if (encodes.split(",").includes(key)) open.handle.keyframe(key);
    this.owedKeys.clear();
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
          // No encoder yet (the extension failed to load): viewers keep JPEG, and it is retried.
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
    const tabId = this.tabId;
    void source.host
      .open(source.page, size.width, size.height, {
        chunk: (chunk) => {
          if (generation === this.generation) this.publish(chunk, tabId);
        },
        failed: (encode) => {
          const codec = encode.split("/")[0];
          if (codec && generation === this.generation) this.failedCodecs.add(codec);
        },
        ended: () => {
          if (generation !== this.generation) return;
          this.capture = undefined;
          this.encodes = "";
          this.fanout.stopAll();
        },
      })
      .then(
        (handle) => {
          if (generation !== this.generation) return handle.close();
          this.capture = { handle, ...size };
          this.encodes = "";
        },
        () => {
          if (generation === this.generation) this.retryAt = this.now() + retryMs;
        },
      )
      .finally(() => {
        this.opening = false;
      });
  }
  private close(): void {
    this.generation++;
    this.capture?.handle.close();
    this.capture = undefined;
    this.encodes = "";
    this.fanout.stopAll();
  }
  private publish(chunk: EncodedChunk, tabId: string | undefined): void {
    const { encode, ...rest } = chunk;
    this.fanout.publish(encode, {
      ...rest,
      sequence: ++this.sequence,
      timestamp: this.now(),
      width: this.page.width,
      height: this.page.height,
      ...(tabId ? { tabId } : {}),
    });
  }
}

function largest(encodes: readonly VideoEncode[]): { width: number; height: number } {
  let width = 0,
    height = 0;
  for (const encode of encodes) {
    width = Math.max(width, encode.width);
    height = Math.max(height, encode.height);
  }
  return { width, height };
}
