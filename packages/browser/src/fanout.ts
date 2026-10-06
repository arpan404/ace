import type { BrowserFrame, BrowserCaptureViewport } from "@ace/protocol";

export interface FrameSink {
  /** False means transport backpressure; no frame was queued. */
  send(frame: BrowserFrame): boolean;
}
interface Viewer {
  sink: FrameSink;
  inflight: number | undefined;
  latest: BrowserFrame | undefined;
  capture?: CaptureViewer;
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
  get captureViewers(): CaptureViewer[] {
    return [...this.viewers.values()].flatMap((viewer) => (viewer.capture ? [viewer.capture] : []));
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
    if (viewer.inflight !== undefined || !viewer.latest) return;
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
    for (const viewer of this.viewers.values()) if (viewer.latest) return true;
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

export interface CaptureViewer {
  viewport: BrowserCaptureViewport;
  local: boolean;
}

/** Bounded shared capture: remote viewers never raise the local resolution or cadence. */
export function captureSettings(
  pressured: boolean,
  viewers: readonly CaptureViewer[] = [],
): {
  fps: number;
  quality: number;
  maxWidth: number;
  maxHeight: number;
} {
  const local = viewers.some((viewer) => viewer.local);
  const cap = local ? 2560 : 1280;
  let maxWidth = viewers.length ? 0 : 1280,
    maxHeight = viewers.length ? 0 : 960;
  for (const viewer of viewers) {
    const { width, height, devicePixelRatio } = viewer.viewport;
    const limit = viewer.local ? cap : 1280;
    const scale = Math.min(devicePixelRatio, limit / Math.max(width, height));
    maxWidth = Math.max(maxWidth, Math.round(width * scale));
    maxHeight = Math.max(maxHeight, Math.round(height * scale));
  }
  return {
    fps: pressured ? 6 : local ? 30 : 15,
    quality: pressured ? 40 : local ? 90 : 80,
    maxWidth: Math.min(cap, maxWidth),
    maxHeight: Math.min(cap, maxHeight),
  };
}

/** Injected observations keep brief decode waits from reducing capture quality. */
export class CapturePressure {
  private since: number | undefined;
  sample(pending: boolean, now: number): boolean {
    if (pending) this.since ??= now;
    else this.since = undefined;
    return this.since !== undefined && now - this.since >= 500;
  }
}
