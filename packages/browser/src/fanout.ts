import type { BrowserFrame } from "@ace/protocol";

export interface FrameSink {
  /** False means transport backpressure; no frame was queued. */
  send(frame: BrowserFrame): boolean;
}
interface Viewer {
  sink: FrameSink;
  inflight: number | undefined;
  latest: BrowserFrame | undefined;
}

/** No timers or I/O. Ack advances one viewer independently of every other viewer. */
export class FrameFanout {
  private viewers = new Map<string, Viewer>();
  private latest: BrowserFrame | undefined;
  subscribe(id: string, sink: FrameSink): () => void {
    if (!this.viewers.has(id) && this.viewers.size >= 64)
      throw new Error("Browser subscriber limit");
    const viewer: Viewer = { sink, inflight: undefined, latest: this.latest };
    this.viewers.set(id, viewer);
    this.flushViewer(viewer);
    return () => {
      if (this.viewers.get(id) === viewer) this.viewers.delete(id);
    };
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
  clear(): void {
    this.viewers.clear();
    this.latest = undefined;
  }
}

export function captureSettings(pressured: boolean): { fps: number; quality: number } {
  return pressured ? { fps: 6, quality: 40 } : { fps: 15, quality: 70 };
}
