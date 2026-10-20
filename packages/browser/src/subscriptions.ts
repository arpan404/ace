import type {
  BrowserAnnotationMessage,
  BrowserBackendLost,
  BrowserPageMessage,
  BrowserState,
} from "@ace/protocol";
import type { CaptureViewer, ViewerSink } from "./viewer-sink.ts";

/** Where a viewer's pictures come from: the live capture's video. */
interface FrameSource {
  subscribe(id: string, sink: ViewerSink, capture?: CaptureViewer): () => void;
}

type Subscriber = {
  connectionId: string;
  sink: ViewerSink;
  state(state: BrowserState): void;
  event?(event: BrowserBackendLost | BrowserAnnotationMessage | BrowserPageMessage): void;
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
    fanout: FrameSource,
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
  replace(threadId: string, fanout: FrameSource): void {
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
  /** A tab's page state goes to every viewer of the thread. */
  page(message: BrowserPageMessage): void {
    this.broadcast(message);
  }
  backendLost(event: BrowserBackendLost): void {
    this.broadcast(event);
  }
  private broadcast(event: BrowserBackendLost | BrowserPageMessage): void {
    for (const viewer of this.threads.get(event.threadId) ?? []) {
      try {
        viewer.event?.(event);
      } catch (error) {
        this.onError(error);
      }
    }
  }
  /** Annotation events go to one connection only: the one that started annotate mode. */
  annotation(connectionId: string, message: BrowserAnnotationMessage): void {
    for (const viewer of this.threads.get(message.threadId) ?? []) {
      if (viewer.connectionId !== connectionId) continue;
      try {
        viewer.event?.(message);
      } catch (error) {
        this.onError(error);
      }
      return;
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
