import type { ThreadId } from "@ace/contracts";

import type { SourceTimelineRowsInput } from "./sourceTimelineRows";
import type { TimelineRow } from "./timelineRows";

export interface SourceTimelineRowsLiveRequest {
  readonly key: string;
  readonly rowsInput: SourceTimelineRowsInput;
  readonly threadId: ThreadId | null;
}

export interface SourceTimelineRowsLiveResult extends SourceTimelineRowsLiveRequest {
  readonly rows: readonly TimelineRow[];
}

interface SourceTimelineRowsLiveScheduler {
  readonly cancelAnimationFrame: (handle: number) => void;
  readonly clearTimeout: (handle: number) => void;
  readonly requestAnimationFrame: (callback: () => void) => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => number;
}

export interface SourceTimelineRowsLiveResolverOptions {
  readonly delayMs: number;
  readonly publishRows: (result: SourceTimelineRowsLiveResult) => void;
  readonly reportError?: (error: unknown) => void;
  readonly resolveRows: (request: SourceTimelineRowsLiveRequest) => Promise<readonly TimelineRow[]>;
  readonly scheduler?: SourceTimelineRowsLiveScheduler;
}

export interface SourceTimelineRowsLiveResolver {
  readonly clear: () => void;
  readonly dispose: () => void;
  readonly setLatest: (request: SourceTimelineRowsLiveRequest) => void;
}

const defaultScheduler: SourceTimelineRowsLiveScheduler = {
  cancelAnimationFrame: (handle) => {
    if (typeof globalThis.cancelAnimationFrame === "function") {
      globalThis.cancelAnimationFrame(handle);
      return;
    }
    globalThis.clearTimeout(handle);
  },
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
  requestAnimationFrame: (callback) => {
    if (typeof globalThis.requestAnimationFrame === "function") {
      return globalThis.requestAnimationFrame(() => callback());
    }
    return globalThis.setTimeout(callback, 16) as unknown as number;
  },
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs) as unknown as number,
};

export function createSourceTimelineRowsLiveResolver(
  options: SourceTimelineRowsLiveResolverOptions,
): SourceTimelineRowsLiveResolver {
  const scheduler = options.scheduler ?? defaultScheduler;
  let disposed = false;
  let inFlight = false;
  let latestRequest: SourceTimelineRowsLiveRequest | null = null;
  let pendingPublish: SourceTimelineRowsLiveResult | null = null;
  let publishFrame: number | null = null;
  let timer: number | null = null;

  const cancelTimer = () => {
    if (timer === null) {
      return;
    }
    scheduler.clearTimeout(timer);
    timer = null;
  };

  const cancelPendingPublish = () => {
    pendingPublish = null;
    if (publishFrame === null) {
      return;
    }
    scheduler.cancelAnimationFrame(publishFrame);
    publishFrame = null;
  };

  const flushPendingPublish = () => {
    publishFrame = null;
    const result = pendingPublish;
    pendingPublish = null;
    if (disposed || result === null) {
      return;
    }
    const current = latestRequest;
    if (current === null || current.threadId !== result.threadId) {
      return;
    }
    options.publishRows(result);
  };

  const schedulePublish = (result: SourceTimelineRowsLiveResult) => {
    if (disposed) {
      return;
    }
    pendingPublish = result;
    if (publishFrame !== null) {
      return;
    }
    publishFrame = scheduler.requestAnimationFrame(flushPendingPublish);
  };

  const schedule = () => {
    if (disposed || inFlight || timer !== null || latestRequest === null) {
      return;
    }
    timer = scheduler.setTimeout(() => {
      timer = null;
      run();
    }, options.delayMs);
  };

  const run = () => {
    const request = latestRequest;
    if (disposed || inFlight || request === null) {
      return;
    }
    inFlight = true;
    options
      .resolveRows(request)
      .then((rows) => {
        if (disposed) {
          return;
        }
        const current = latestRequest;
        if (current === null || current.threadId !== request.threadId) {
          return;
        }
        schedulePublish({ ...request, rows });
      })
      .catch((error) => {
        if (!disposed) {
          options.reportError?.(error);
        }
      })
      .finally(() => {
        inFlight = false;
        if (disposed) {
          return;
        }
        if (latestRequest !== null && latestRequest.key !== request.key) {
          schedule();
        }
      });
  };

  return {
    clear: () => {
      latestRequest = null;
      cancelTimer();
      cancelPendingPublish();
    },
    dispose: () => {
      disposed = true;
      latestRequest = null;
      cancelTimer();
      cancelPendingPublish();
    },
    setLatest: (request) => {
      if (disposed) {
        return;
      }
      latestRequest = request;
      schedule();
    },
  };
}
