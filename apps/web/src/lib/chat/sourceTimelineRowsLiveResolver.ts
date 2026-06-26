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
  readonly clearTimeout: (handle: number) => void;
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
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs) as unknown as number,
};

export function createSourceTimelineRowsLiveResolver(
  options: SourceTimelineRowsLiveResolverOptions,
): SourceTimelineRowsLiveResolver {
  const scheduler = options.scheduler ?? defaultScheduler;
  let disposed = false;
  let inFlight = false;
  let latestRequest: SourceTimelineRowsLiveRequest | null = null;
  let timer: number | null = null;

  const cancelTimer = () => {
    if (timer === null) {
      return;
    }
    scheduler.clearTimeout(timer);
    timer = null;
  };

  const publish = (result: SourceTimelineRowsLiveResult) => {
    if (disposed || result === null) {
      return;
    }
    const current = latestRequest;
    if (current === null || current.threadId !== result.threadId) {
      return;
    }
    options.publishRows(result);
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
        publish({ ...request, rows });
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
    },
    dispose: () => {
      disposed = true;
      latestRequest = null;
      cancelTimer();
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
