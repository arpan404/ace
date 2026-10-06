import type { BrowserBackendLost, BrowserState } from "@ace/protocol";
import type { CaptureViewer, FrameFanout, FrameSink } from "./fanout.ts";

type Subscriber = {
  connectionId: string;
  sink: FrameSink;
  state(state: BrowserState): void;
  backendLost?(event: BrowserBackendLost): void;
  stopFrames(): void;
  capture?: CaptureViewer;
};
function detachFrames(viewer: Subscriber): void {
  viewer.stopFrames();
  // Closed logical subscriptions must not retain the old viewer's pending frame.
  viewer.stopFrames = () => {};
}

/** Logical viewers outlive a page. Only their frame binding belongs to the physical session. */
export class BrowserSubscriptions {
  private threads = new Map<string, Set<Subscriber>>();
  private count = 0;
  private readonly limit: number;
  private readonly onError: (error: unknown) => void;
  constructor(limit: number, onError: (error: unknown) => void) {
    this.limit = limit;
    this.onError = onError;
  }
  add(
    threadId: string,
    fanout: FrameFanout,
    state: BrowserState,
    viewer: Omit<Subscriber, "stopFrames">,
  ): () => void {
    let viewers = this.threads.get(threadId);
    if (this.count >= this.limit || (viewers?.size ?? 0) >= 64)
      throw new Error("Browser subscriber limit");
    if (!viewers) {
      viewers = new Set();
      this.threads.set(threadId, viewers);
    }
    const owned: Subscriber = { ...viewer, stopFrames() {} };
    viewers.add(owned);
    this.count++;
    const unsubscribe = () => {
      detachFrames(owned);
      if (viewers.delete(owned)) this.count--;
      if (!viewers.size && this.threads.get(threadId) === viewers) this.threads.delete(threadId);
    };
    try {
      owned.stopFrames = fanout.subscribe(owned.connectionId, owned.sink, owned.capture);
      owned.state(state);
    } catch (error) {
      unsubscribe();
      throw error;
    }
    return unsubscribe;
  }
  configure(threadId: string, connectionId: string, capture: CaptureViewer): void {
    for (const viewer of this.threads.get(threadId) ?? []) {
      if (viewer.connectionId === connectionId) viewer.capture = capture;
    }
  }
  replace(threadId: string, fanout: FrameFanout): void {
    for (const viewer of this.threads.get(threadId) ?? []) {
      detachFrames(viewer);
      const stop = fanout.subscribe(viewer.connectionId, viewer.sink, viewer.capture);
      // Initial frame delivery may synchronously unsubscribe this logical viewer.
      if (this.threads.get(threadId)?.has(viewer)) viewer.stopFrames = stop;
      else stop();
    }
  }
  state(state: BrowserState): void {
    for (const viewer of this.threads.get(state.threadId) ?? []) {
      try {
        viewer.state(state);
      } catch (error) {
        this.onError(error);
      }
      if (state.closed) detachFrames(viewer);
    }
  }
  backendLost(event: BrowserBackendLost): void {
    for (const viewer of this.threads.get(event.threadId) ?? []) {
      try {
        viewer.backendLost?.(event);
      } catch (error) {
        this.onError(error);
      }
    }
  }
  clear(): void {
    for (const viewers of this.threads.values()) {
      for (const viewer of viewers) detachFrames(viewer);
      viewers.clear();
    }
    this.threads.clear();
    this.count = 0;
  }
}
