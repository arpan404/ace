import type { BrowserFrame } from "@ace/protocol";
import type { CaptureViewer } from "./capture-policy.ts";
import type { BrowserVideoChunk } from "./stream-video.ts";
import type { VideoSink } from "./video-fanout.ts";
export type { CaptureViewer } from "./capture-policy.ts";

export interface FrameSink {
  /** False means transport backpressure; no frame was queued. */
  send(frame: BrowserFrame): boolean;
  /** Takes encoded video (ADR 0088); a viewer without it, or without codecs, gets JPEG only. */
  video?: VideoSink<BrowserVideoChunk>;
}
interface Viewer {
  sink: FrameSink;
  inflight: number | undefined;
  latest: BrowserFrame | undefined;
  capture?: CaptureViewer;
  /** Shows video now: JPEG frames wait (only the newest is kept) until it stops. */
  paused?: boolean;
}

/** No timers or I/O. Ack advances one viewer independently of every other viewer. */
export class FrameFanout {
  private viewers = new Map<string, Viewer>();
  private latest: BrowserFrame | undefined;
  subscribe(id: string, sink: FrameSink, capture?: CaptureViewer): () => void {
    if (!this.viewers.has(id) && this.viewers.size >= 64)
      throw new Error("Browser subscriber limit");
    const viewer: Viewer = {
      sink,
      inflight: undefined,
      latest: this.latest,
      ...(capture ? { capture } : {}),
    };
    this.viewers.set(id, viewer);
    this.flushViewer(viewer);
    return () => {
      if (this.viewers.get(id) === viewer) this.viewers.delete(id);
    };
  }
  configure(id: string, capture: CaptureViewer): void {
    const viewer = this.viewers.get(id);
    if (viewer) viewer.capture = capture;
  }
  /** What the JPEG capture sizes for: viewers showing video take none of its frames. */
  get captureViewers(): CaptureViewer[] {
    return [...this.viewers.values()].flatMap((viewer) =>
      viewer.capture && !viewer.paused ? [viewer.capture] : [],
    );
  }
  /** A viewer started (true) or stopped showing video; stopping sends it the newest frame. */
  pause(id: string, paused: boolean): void {
    const viewer = this.viewers.get(id);
    if (!viewer || (viewer.paused ?? false) === paused) return;
    viewer.paused = paused;
    viewer.inflight = undefined;
    if (paused) viewer.latest = undefined;
    else {
      viewer.latest = this.latest;
      this.flushViewer(viewer);
    }
  }
  replay(id: string): void {
    const viewer = this.viewers.get(id);
    if (!viewer) return;
    viewer.inflight = undefined;
    viewer.latest = this.latest;
    this.flushViewer(viewer);
  }
  publish(frame: BrowserFrame): void {
    this.latest = frame;
    for (const viewer of this.viewers.values()) {
      viewer.latest = frame;
      this.flushViewer(viewer);
    }
  }
  acknowledge(id: string, sequence: number): void {
    const viewer = this.viewers.get(id);
    if (!viewer || viewer.inflight !== sequence) return;
    viewer.inflight = undefined;
    this.flushViewer(viewer);
  }
  flush(): void {
    for (const viewer of this.viewers.values()) this.flushViewer(viewer);
  }
  private flushViewer(viewer: Viewer): void {
    if (viewer.paused || viewer.inflight !== undefined || !viewer.latest) return;
    const frame = viewer.latest;
    // Set before send so synchronous test transports may acknowledge immediately.
    viewer.latest = undefined;
    viewer.inflight = frame.sequence;
    try {
      if (!viewer.sink.send(frame)) {
        viewer.inflight = undefined;
        viewer.latest = frame;
      }
    } catch {
      viewer.inflight = undefined;
      viewer.latest = frame;
    }
  }
  get pressured(): boolean {
    for (const viewer of this.viewers.values()) if (viewer.latest && !viewer.paused) return true;
    return false;
  }
  invalidate(): void {
    this.latest = undefined;
    for (const viewer of this.viewers.values()) {
      viewer.latest = undefined;
      viewer.inflight = undefined;
    }
  }
  clear(): void {
    this.viewers.clear();
    this.latest = undefined;
  }
}
