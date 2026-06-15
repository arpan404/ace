import { MessageId, ThreadId } from "@ace/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSourceTimelineRowsLiveResolver,
  type SourceTimelineRowsLiveRequest,
  type SourceTimelineRowsLiveResult,
} from "./sourceTimelineRowsLiveResolver";
import type { SourceTimelineRowsInput } from "./sourceTimelineRows";
import type { TimelineRow } from "./timelineRows";

function makeRowsInput(id: string): SourceTimelineRowsInput {
  return {
    rows: [
      {
        id: `message:${id}`,
        kind: "message",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        contentVersion: `live:${id}`,
        startSourceIndex: 0,
        endSourceIndexExclusive: 1,
        sourceRefs: [
          {
            kind: "message",
            id,
            createdAt: "2026-01-01T00:00:00.000Z",
            sourceIndex: 0,
          },
        ],
      },
    ],
    messages: [
      {
        id: MessageId.makeUnsafe(id),
        role: "assistant",
        text: id,
        turnId: null,
        streaming: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    activities: [],
    proposedPlans: [],
    activeTurnId: null,
    activeTurnInProgress: true,
    activeTurnStartedAt: "2026-01-01T00:00:00.000Z",
    completionDividerBeforeEntryId: null,
    completionEndedAt: null,
    completionStartedAt: null,
    completionSummary: null,
    completionTurnId: null,
    hideCompletedWorkMessages: false,
    turnDiffSummaryByAssistantMessageId: new Map(),
  };
}

function makeRows(id: string): TimelineRow[] {
  return [
    {
      id: `timeline:${id}`,
      kind: "message",
      message: {
        id: MessageId.makeUnsafe(id),
        role: "assistant",
        text: id,
        turnId: null,
        streaming: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    } as TimelineRow,
  ];
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

describe("sourceTimelineRowsLiveResolver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("publishes in-flight active rows and schedules the latest request afterwards", async () => {
    const threadId = ThreadId.makeUnsafe("thread-live-rows");
    const first = createDeferred<readonly TimelineRow[]>();
    const second = createDeferred<readonly TimelineRow[]>();
    const requests: SourceTimelineRowsLiveRequest[] = [];
    const published: SourceTimelineRowsLiveResult[] = [];

    const resolver = createSourceTimelineRowsLiveResolver({
      delayMs: 16,
      publishRows: (result) => published.push(result),
      resolveRows: (request) => {
        requests.push(request);
        return requests.length === 1 ? first.promise : second.promise;
      },
    });

    resolver.setLatest({
      key: "first",
      rowsInput: makeRowsInput("first"),
      threadId,
    });
    vi.advanceTimersByTime(16);
    expect(requests.map((request) => request.key)).toEqual(["first"]);

    resolver.setLatest({
      key: "second",
      rowsInput: makeRowsInput("second"),
      threadId,
    });
    vi.advanceTimersByTime(100);
    expect(requests.map((request) => request.key)).toEqual(["first"]);

    first.resolve(makeRows("first"));
    await vi.runAllTimersAsync();
    expect(published.map((result) => result.key)).toEqual(["first"]);

    vi.advanceTimersByTime(16);
    expect(requests.map((request) => request.key)).toEqual(["first", "second"]);

    second.resolve(makeRows("second"));
    await vi.runAllTimersAsync();
    expect(published.map((result) => result.key)).toEqual(["first", "second"]);
  });

  it("drops an in-flight result after the resolver is cleared", async () => {
    const threadId = ThreadId.makeUnsafe("thread-live-clear");
    const deferred = createDeferred<readonly TimelineRow[]>();
    const published: SourceTimelineRowsLiveResult[] = [];
    const resolver = createSourceTimelineRowsLiveResolver({
      delayMs: 16,
      publishRows: (result) => published.push(result),
      resolveRows: () => deferred.promise,
    });

    resolver.setLatest({
      key: "stale",
      rowsInput: makeRowsInput("stale"),
      threadId,
    });
    vi.advanceTimersByTime(16);
    resolver.clear();

    deferred.resolve(makeRows("stale"));
    await vi.runAllTimersAsync();

    expect(published).toEqual([]);
  });
});
