import {
  EventId,
  MessageId,
  type OrchestrationGetThreadTimelinePageRangeInput,
  ProjectId,
  ThreadId,
  TurnId,
} from "@ace/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const nativeApiMock = vi.hoisted(() => ({
  getThreadTimelineManifest: vi.fn(),
  getThreadTimelinePage: vi.fn(),
  getThreadTimelinePages: vi.fn(),
}));
const storageMock = vi.hoisted(() => ({
  readPersistedThreadTimelineCache: vi.fn(),
  readPersistedThreadTimelinePages: vi.fn(),
  writePersistedThreadTimelineCache: vi.fn(),
  writePersistedThreadTimelinePage: vi.fn(),
}));

vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({
    orchestration: nativeApiMock,
  }),
}));
vi.mock("./threadTimelineStorage", () => ({
  readPersistedThreadTimelineCache: storageMock.readPersistedThreadTimelineCache,
  readPersistedThreadTimelinePages: storageMock.readPersistedThreadTimelinePages,
  writePersistedThreadTimelineCache: storageMock.writePersistedThreadTimelineCache,
  writePersistedThreadTimelinePage: storageMock.writePersistedThreadTimelinePage,
  clearPersistedThreadTimelineCache: vi.fn(),
  readAllPersistedTimelineCacheKeysForStorage: vi.fn(),
}));

import {
  ensureThreadTimelineRange,
  fetchThreadTimelinePages,
  prefetchThreadTimelineAroundLoadedWindow,
  prefetchThreadTimelineWindows,
  hydrateThreadTimelineCacheFromStorage,
  primeThreadTimelineManifestFromReadModelThread,
  readCachedThreadTimelinePage,
  readLoadedThreadTimelinePages,
  readTimelineRowHeight,
  resolveTimelineScrollPrefetchPageSize,
  startThreadTimelineOpenPrefetch,
  TIMELINE_FETCH_STATE_STALE_MS,
  TIMELINE_PAGE_CLIENT_BATCH_LIMIT,
  TIMELINE_PAGE_FETCH_RETRY_BASE_DELAY_MS,
  TIMELINE_PAGE_RPC_BATCH_LIMIT,
  TIMELINE_PAGE_FETCH_TIMEOUT_MS,
  useTimelineWindowStore,
  writeTimelineRowHeight,
} from "./timelineWindowStore";

const threadId = ThreadId.makeUnsafe("thread-window-store");
const turnId = TurnId.makeUnsafe("turn-window-store");

afterEach(() => {
  vi.useRealTimers();
  useTimelineWindowStore.getState().reset();
  nativeApiMock.getThreadTimelineManifest.mockReset();
  nativeApiMock.getThreadTimelinePage.mockReset();
  nativeApiMock.getThreadTimelinePages.mockReset();
  storageMock.readPersistedThreadTimelineCache.mockReset();
  storageMock.readPersistedThreadTimelinePages.mockReset();
  storageMock.writePersistedThreadTimelineCache.mockReset();
  storageMock.writePersistedThreadTimelinePage.mockReset();
});

function makeTimelinePage(input: {
  readonly startIndex: number;
  readonly limit: number;
  readonly totalItems: number;
}) {
  const endIndexExclusive = Math.min(input.totalItems, input.startIndex + input.limit);
  return {
    threadId,
    updatedAt: "2026-01-01T00:00:02.000Z",
    totalItems: input.totalItems,
    startIndex: input.startIndex,
    endIndexExclusive,
    hasPrevious: input.startIndex > 0,
    hasNext: endIndexExclusive < input.totalItems,
    entries: [],
    messages: [],
    activities: [],
    proposedPlans: [],
  };
}

function mockTimelinePagesBatch(totalItems: number) {
  nativeApiMock.getThreadTimelinePages.mockImplementation(async (input) =>
    input.pages.map((page: OrchestrationGetThreadTimelinePageRangeInput) =>
      makeTimelinePage({
        startIndex: page.anchor === "tail" ? Math.max(0, totalItems - page.limit) : page.startIndex,
        limit: page.limit,
        totalItems,
      }),
    ),
  );
}

describe("timelineWindowStore", () => {
  it("maps scroll velocity to exponential prefetch page sizes", () => {
    expect(resolveTimelineScrollPrefetchPageSize(0)).toBe(100);
    expect(resolveTimelineScrollPrefetchPageSize(0.74)).toBe(100);
    expect(resolveTimelineScrollPrefetchPageSize(0.75)).toBe(250);
    expect(resolveTimelineScrollPrefetchPageSize(1.5)).toBe(500);
    expect(resolveTimelineScrollPrefetchPageSize(3)).toBe(500);
    expect(resolveTimelineScrollPrefetchPageSize(6)).toBe(500);
    expect(resolveTimelineScrollPrefetchPageSize(10)).toBe(500);
    expect(resolveTimelineScrollPrefetchPageSize(100)).toBe(500);
  });

  it("stores manifests and bounded page metadata separately from page bodies", () => {
    const page = {
      threadId,
      updatedAt: "2026-01-01T00:00:02.000Z",
      totalItems: 2,
      startIndex: 0,
      endIndexExclusive: 2,
      hasPrevious: false,
      hasNext: false,
      entries: [
        {
          kind: "message" as const,
          id: "message-window-store",
          createdAt: "2026-01-01T00:00:01.000Z",
          index: 0,
          turnId,
          sequence: 1,
        },
        {
          kind: "activity" as const,
          id: "activity-window-store",
          createdAt: "2026-01-01T00:00:02.000Z",
          index: 1,
          turnId,
          sequence: 2,
        },
      ],
      messages: [
        {
          id: MessageId.makeUnsafe("message-window-store"),
          role: "user" as const,
          text: "Start",
          turnId,
          streaming: false,
          sequence: 1,
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
      ],
      activities: [
        {
          id: EventId.makeUnsafe("activity-window-store"),
          tone: "tool" as const,
          kind: "tool.completed",
          summary: "Run command",
          payload: {},
          turnId,
          sequence: 2,
          createdAt: "2026-01-01T00:00:02.000Z",
        },
      ],
      proposedPlans: [],
    };

    useTimelineWindowStore.getState().primePage(page);

    expect(useTimelineWindowStore.getState().manifestsByThreadId[threadId]).toMatchObject({
      totalItems: 2,
      source: "page",
    });
    expect(useTimelineWindowStore.getState().loadedRangesByThreadId[threadId]).toEqual([
      expect.objectContaining({
        startIndex: 0,
        endIndexExclusive: 2,
      }),
    ]);
    expect(
      readCachedThreadTimelinePage({
        threadId,
        updatedAt: page.updatedAt,
        startIndex: 0,
        limit: 2,
      }),
    ).toBe(page);
  });

  it("tracks active windows and row height cache outside large page state", () => {
    useTimelineWindowStore.getState().setActiveWindow(threadId, {
      startIndex: 10,
      endIndexExclusive: 20,
      overscanStartIndex: 8,
      overscanEndIndexExclusive: 24,
      updatedAt: "scope-a",
    });
    writeTimelineRowHeight("row-height-key", 42);

    expect(useTimelineWindowStore.getState().activeWindowByThreadId[threadId]).toEqual({
      startIndex: 10,
      endIndexExclusive: 20,
      overscanStartIndex: 8,
      overscanEndIndexExclusive: 24,
      updatedAt: "scope-a",
    });
    expect(readTimelineRowHeight("row-height-key")).toBe(42);
  });

  it("keeps previously loaded ranges when newer pages advance thread updatedAt", () => {
    const oldPage = {
      threadId,
      updatedAt: "2026-01-01T00:00:02.000Z",
      totalItems: 4,
      startIndex: 0,
      endIndexExclusive: 2,
      hasPrevious: false,
      hasNext: true,
      entries: [
        {
          kind: "activity" as const,
          id: "activity-old-range",
          createdAt: "2026-01-01T00:00:01.000Z",
          index: 0,
          turnId,
          sequence: 1,
        },
      ],
      messages: [],
      activities: [
        {
          id: EventId.makeUnsafe("activity-old-range"),
          tone: "tool" as const,
          kind: "tool.completed",
          summary: "Older tool call",
          payload: {},
          turnId,
          sequence: 1,
          createdAt: "2026-01-01T00:00:01.000Z",
        },
      ],
      proposedPlans: [],
    };
    const newPage = {
      threadId,
      updatedAt: "2026-01-01T00:00:05.000Z",
      totalItems: 5,
      startIndex: 4,
      endIndexExclusive: 5,
      hasPrevious: true,
      hasNext: false,
      entries: [
        {
          kind: "message" as const,
          id: "message-new-range",
          createdAt: "2026-01-01T00:00:05.000Z",
          index: 4,
          turnId,
          sequence: 5,
        },
      ],
      messages: [
        {
          id: MessageId.makeUnsafe("message-new-range"),
          role: "assistant" as const,
          text: "Done",
          turnId,
          streaming: false,
          sequence: 5,
          createdAt: "2026-01-01T00:00:05.000Z",
          updatedAt: "2026-01-01T00:00:05.000Z",
        },
      ],
      activities: [],
      proposedPlans: [],
    };

    useTimelineWindowStore.getState().primePage(oldPage);
    useTimelineWindowStore.getState().primePage(newPage);

    expect(readLoadedThreadTimelinePages(threadId)).toEqual([oldPage, newPage]);
  });

  it("can prime a manifest from a read-model thread without storing the full timeline in state", () => {
    primeThreadTimelineManifestFromReadModelThread({
      id: threadId,
      projectId: ProjectId.makeUnsafe("project-for-manifest"),
      title: "Manifest thread",
      modelSelection: { provider: "codex", model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:03.000Z",
      archivedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      latestProposedPlanSummary: null,
      queuedComposerMessages: [],
      queuedSteerRequest: null,
      activities: [],
      checkpoints: [],
      session: null,
    });

    expect(useTimelineWindowStore.getState().manifestsByThreadId[threadId]).toMatchObject({
      totalItems: 0,
      source: "hydrated",
    });
  });

  it("loads latest 50 first with a tail anchor, then warms a larger older batch in background", async () => {
    nativeApiMock.getThreadTimelinePage.mockImplementation(async (input) =>
      makeTimelinePage({
        startIndex: input.anchor === "tail" ? 190 : input.startIndex,
        limit: input.limit,
        totalItems: 240,
      }),
    );

    await prefetchThreadTimelineWindows({ threadId, priority: "immediate" });

    expect(nativeApiMock.getThreadTimelineManifest).not.toHaveBeenCalled();
    expect(nativeApiMock.getThreadTimelinePage.mock.calls[0]?.[0]).toMatchObject({
      anchor: "tail",
      startIndex: 0,
      limit: 50,
    });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (nativeApiMock.getThreadTimelinePage.mock.calls.length >= 2) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(nativeApiMock.getThreadTimelinePage.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ anchor: "tail", startIndex: 0, limit: 50 }),
      expect.objectContaining({ startIndex: 90, limit: 100 }),
      expect.objectContaining({ startIndex: 0, limit: 90 }),
    ]);
  });

  it("continues fetching older open-thread pages until the timeline reaches the top", async () => {
    nativeApiMock.getThreadTimelinePage.mockImplementation(async (input) =>
      makeTimelinePage({
        startIndex: input.anchor === "tail" ? 950 : input.startIndex,
        limit: input.limit,
        totalItems: 1_000,
      }),
    );
    mockTimelinePagesBatch(1_000);

    const prefetch = startThreadTimelineOpenPrefetch({
      threadId,
      priority: "immediate",
      batchSizes: [100, 200, 4_000],
      delayMs: 0,
    });
    await prefetch.done;
    prefetch.stop();

    expect(nativeApiMock.getThreadTimelinePage.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ anchor: "tail", startIndex: 0, limit: 50 }),
      expect.objectContaining({ startIndex: 850, limit: 100 }),
      expect.objectContaining({ startIndex: 650, limit: 200 }),
      expect.objectContaining({ startIndex: 150, limit: 500 }),
      expect.objectContaining({ startIndex: 0, limit: 150 }),
    ]);
    expect(nativeApiMock.getThreadTimelinePages).not.toHaveBeenCalled();
  });

  it("hydrates timeline cache from storage", async () => {
    const cachedPage = makeTimelinePage({
      startIndex: 0,
      limit: 100,
      totalItems: 200,
    });
    const cacheKey = `${threadId}:2026-01-01T00:00:02.000Z:index:0:100`;
    storageMock.readPersistedThreadTimelineCache.mockResolvedValue({
      manifest: {
        threadId,
        updatedAt: cachedPage.updatedAt,
        totalItems: 200,
        tailStartIndex: 100,
        source: "metadata",
      },
      ranges: [
        {
          startIndex: 0,
          endIndexExclusive: 100,
          cacheKey,
          updatedAt: cachedPage.updatedAt,
        },
      ],
      lastPersistedAt: Date.now(),
    });
    storageMock.readPersistedThreadTimelinePages.mockResolvedValue(
      new Map([[cacheKey, cachedPage]]),
    );

    await hydrateThreadTimelineCacheFromStorage(threadId);

    expect(storageMock.readPersistedThreadTimelineCache).toHaveBeenCalledWith(threadId);
    expect(storageMock.readPersistedThreadTimelinePages).toHaveBeenCalledWith([cacheKey]);
    expect(readLoadedThreadTimelinePages(threadId)).toEqual([cachedPage]);
  });

  it("persists fetched pages to storage", async () => {
    vi.useFakeTimers();
    nativeApiMock.getThreadTimelinePage.mockImplementation(async (input) =>
      makeTimelinePage({
        startIndex: input.startIndex,
        limit: input.limit,
        totalItems: 1_000,
      }),
    );

    await fetchThreadTimelinePages([
      { threadId, startIndex: 700, limit: 100 },
      { threadId, startIndex: 800, limit: 100 },
    ]);
    await vi.advanceTimersByTimeAsync(250);

    expect(storageMock.writePersistedThreadTimelinePage).toHaveBeenCalledTimes(2);
    expect(storageMock.writePersistedThreadTimelineCache).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("continues open-thread background fetching after the retained range cap is full", async () => {
    nativeApiMock.getThreadTimelinePage.mockImplementation(async (input) =>
      makeTimelinePage({
        startIndex: input.anchor === "tail" ? 9_950 : input.startIndex,
        limit: input.limit,
        totalItems: 10_000,
      }),
    );
    mockTimelinePagesBatch(10_000);

    const prefetch = startThreadTimelineOpenPrefetch({
      threadId,
      priority: "immediate",
      batchSizes: [100],
      delayMs: 0,
    });
    await prefetch.done;
    prefetch.stop();

    const pageRequests = nativeApiMock.getThreadTimelinePage.mock.calls
      .map((call) => call[0])
      .filter((request) => request.anchor !== "tail");
    const ranges = useTimelineWindowStore.getState().loadedRangesByThreadId[threadId] ?? [];
    expect(pageRequests.length).toBe(100);
    expect(ranges).toHaveLength(101);
    expect(ranges[0]).toMatchObject({ startIndex: 0, endIndexExclusive: 50 });
    expect(ranges.at(-1)).toMatchObject({ startIndex: 9_950, endIndexExclusive: 10_000 });
  });

  it("commits fetched page batches in bounded client chunks", async () => {
    mockTimelinePagesBatch(1_000);
    nativeApiMock.getThreadTimelinePage.mockImplementation(async (input) =>
      makeTimelinePage({
        startIndex: input.startIndex,
        limit: input.limit,
        totalItems: 1_000,
      }),
    );

    const revisionBefore = useTimelineWindowStore.getState().pageCacheRevision;
    await fetchThreadTimelinePages([
      { threadId, startIndex: 700, limit: 100 },
      { threadId, startIndex: 800, limit: 100 },
      { threadId, startIndex: 900, limit: 100 },
    ]);

    expect(nativeApiMock.getThreadTimelinePages).toHaveBeenCalledTimes(1);
    expect(nativeApiMock.getThreadTimelinePage).toHaveBeenCalledTimes(1);
    expect(useTimelineWindowStore.getState().pageCacheRevision).toBe(revisionBefore + 2);
    expect(readLoadedThreadTimelinePages(threadId).map((page) => page.startIndex)).toEqual([
      700, 800, 900,
    ]);
  });

  it("splits page batches so RPC payloads stay below the client ingest limit", async () => {
    mockTimelinePagesBatch(100_000);

    const requests = Array.from({ length: 12 }, (_, index) => ({
      threadId,
      startIndex: 50_000 + index * 4_000,
      limit: 4_000,
    }));
    await fetchThreadTimelinePages(requests);

    expect(nativeApiMock.getThreadTimelinePages).toHaveBeenCalledTimes(6);
    expect(
      nativeApiMock.getThreadTimelinePages.mock.calls.every(
        (call) =>
          call[0].pages.length <= TIMELINE_PAGE_CLIENT_BATCH_LIMIT &&
          call[0].pages.length <= TIMELINE_PAGE_RPC_BATCH_LIMIT &&
          call[0].pages.every(
            (page: OrchestrationGetThreadTimelinePageRangeInput) => page.limit <= 500,
          ),
      ),
    ).toBe(true);
    expect(
      nativeApiMock.getThreadTimelinePages.mock.calls.map((call) => call[0].pages.length),
    ).toEqual([2, 2, 2, 2, 2, 2]);
  });

  it("tracks in-flight page batch fetches per thread", async () => {
    let resolveBatch!: () => void;
    nativeApiMock.getThreadTimelinePages.mockImplementation(async (input) => {
      await new Promise<void>((resolve) => {
        resolveBatch = resolve;
      });
      return input.pages.map((page: OrchestrationGetThreadTimelinePageRangeInput) =>
        makeTimelinePage({
          startIndex: page.startIndex,
          limit: page.limit,
          totalItems: 1_000,
        }),
      );
    });

    const fetchPromise = fetchThreadTimelinePages([
      { threadId, startIndex: 700, limit: 100 },
      { threadId, startIndex: 800, limit: 100 },
    ]);
    await Promise.resolve();

    expect(useTimelineWindowStore.getState().fetchStateByThreadId[threadId]?.inFlightCount).toBe(2);

    resolveBatch();
    await fetchPromise;

    expect(useTimelineWindowStore.getState().fetchStateByThreadId[threadId]?.inFlightCount).toBe(0);
  });

  it("expires stale in-flight page fetch state", () => {
    useTimelineWindowStore.getState().beginPageFetches(threadId, 2);
    const startedAt = useTimelineWindowStore.getState().fetchStateByThreadId[threadId]?.startedAt;
    expect(startedAt).toEqual(expect.any(Number));

    useTimelineWindowStore
      .getState()
      .expireStalePageFetches(threadId, startedAt! + TIMELINE_FETCH_STATE_STALE_MS + 1);

    expect(useTimelineWindowStore.getState().fetchStateByThreadId[threadId]).toMatchObject({
      inFlightCount: 0,
    });
  });

  it("retries timed-out page batches and clears in-flight state", async () => {
    vi.useFakeTimers();
    nativeApiMock.getThreadTimelinePages
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementationOnce(async (input) =>
        input.pages.map((page: OrchestrationGetThreadTimelinePageRangeInput) =>
          makeTimelinePage({
            startIndex: page.startIndex,
            limit: page.limit,
            totalItems: 1_000,
          }),
        ),
      );

    const fetchPromise = fetchThreadTimelinePages([
      { threadId, startIndex: 700, limit: 100 },
      { threadId, startIndex: 800, limit: 100 },
    ]);
    await Promise.resolve();

    expect(useTimelineWindowStore.getState().fetchStateByThreadId[threadId]?.inFlightCount).toBe(2);

    await vi.advanceTimersByTimeAsync(TIMELINE_PAGE_FETCH_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(TIMELINE_PAGE_FETCH_RETRY_BASE_DELAY_MS);
    await fetchPromise;

    expect(nativeApiMock.getThreadTimelinePages).toHaveBeenCalledTimes(2);
    expect(useTimelineWindowStore.getState().fetchStateByThreadId[threadId]?.inFlightCount).toBe(0);
  });

  it("clears in-flight state after exhausted page batch retries", async () => {
    vi.useFakeTimers();
    nativeApiMock.getThreadTimelinePages.mockImplementation(() => new Promise(() => {}));

    const fetchPromise = fetchThreadTimelinePages([
      { threadId, startIndex: 700, limit: 100 },
      { threadId, startIndex: 800, limit: 100 },
    ]);
    const fetchRejection = expect(fetchPromise).rejects.toThrow("getThreadTimelinePages timed out");
    await Promise.resolve();

    expect(useTimelineWindowStore.getState().fetchStateByThreadId[threadId]?.inFlightCount).toBe(2);

    await vi.advanceTimersByTimeAsync(TIMELINE_PAGE_FETCH_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(TIMELINE_PAGE_FETCH_RETRY_BASE_DELAY_MS);
    await vi.advanceTimersByTimeAsync(TIMELINE_PAGE_FETCH_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(TIMELINE_PAGE_FETCH_RETRY_BASE_DELAY_MS * 2);
    await vi.advanceTimersByTimeAsync(TIMELINE_PAGE_FETCH_TIMEOUT_MS);

    await fetchRejection;
    expect(nativeApiMock.getThreadTimelinePages).toHaveBeenCalledTimes(3);
    expect(useTimelineWindowStore.getState().fetchStateByThreadId[threadId]?.inFlightCount).toBe(0);
  });

  it("dedupes retained open-thread prefetch jobs for the same thread", async () => {
    nativeApiMock.getThreadTimelinePage.mockImplementation(async (input) =>
      makeTimelinePage({
        startIndex: input.anchor === "tail" ? 950 : input.startIndex,
        limit: input.limit,
        totalItems: 1_000,
      }),
    );

    const firstPrefetch = startThreadTimelineOpenPrefetch({
      threadId,
      priority: "immediate",
      batchSizes: [1_000],
      delayMs: 0,
    });
    const secondPrefetch = startThreadTimelineOpenPrefetch({
      threadId,
      priority: "immediate",
      batchSizes: [1_000],
      delayMs: 0,
    });
    await Promise.all([firstPrefetch.done, secondPrefetch.done]);
    firstPrefetch.stop();
    secondPrefetch.stop();

    expect(
      nativeApiMock.getThreadTimelinePage.mock.calls.filter((call) => call[0].anchor === "tail"),
    ).toHaveLength(1);
    expect(nativeApiMock.getThreadTimelinePage.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ anchor: "tail", startIndex: 0, limit: 50 }),
      expect.objectContaining({ startIndex: 450, limit: 500 }),
      expect.objectContaining({ startIndex: 0, limit: 450 }),
    ]);
  });

  it("reuses the loaded tail page for repeated tail-anchor prefetches", async () => {
    nativeApiMock.getThreadTimelinePage.mockImplementation(async (input) =>
      makeTimelinePage({
        startIndex: input.anchor === "tail" ? 190 : input.startIndex,
        limit: input.limit,
        totalItems: 240,
      }),
    );

    await prefetchThreadTimelineWindows({ threadId, priority: "immediate" });
    await prefetchThreadTimelineWindows({ threadId, priority: "immediate" });

    expect(
      nativeApiMock.getThreadTimelinePage.mock.calls.filter((call) => call[0].anchor === "tail"),
    ).toHaveLength(1);
  });

  it("loads one exact 100-entry slice around the current window on scroll", async () => {
    nativeApiMock.getThreadTimelinePage.mockImplementation(async (input) =>
      makeTimelinePage({
        startIndex: input.startIndex,
        limit: input.limit,
        totalItems: 240,
      }),
    );
    useTimelineWindowStore.getState().primePage(
      makeTimelinePage({
        startIndex: 190,
        limit: 50,
        totalItems: 240,
      }),
    );

    await prefetchThreadTimelineAroundLoadedWindow({ threadId, priority: "immediate" });

    expect(nativeApiMock.getThreadTimelinePage.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ startIndex: 90, limit: 100 }),
    ]);
  });

  it("uses the requested dynamic slice size and fetches only older direction", async () => {
    nativeApiMock.getThreadTimelinePage.mockImplementation(async (input) =>
      makeTimelinePage({
        startIndex: input.startIndex,
        limit: input.limit,
        totalItems: 10_000,
      }),
    );
    useTimelineWindowStore.getState().primePage(
      makeTimelinePage({
        startIndex: 9_950,
        limit: 50,
        totalItems: 10_000,
      }),
    );

    await prefetchThreadTimelineAroundLoadedWindow({
      threadId,
      priority: "immediate",
      pageSize: 250,
      direction: "older",
    });

    expect(nativeApiMock.getThreadTimelinePage.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ startIndex: 9_700, limit: 250 }),
    ]);
  });

  it("can fetch multiple older pages around the loaded window in one request cycle", async () => {
    mockTimelinePagesBatch(10_000);
    useTimelineWindowStore.getState().primePage(
      makeTimelinePage({
        startIndex: 9_950,
        limit: 50,
        totalItems: 10_000,
      }),
    );

    await prefetchThreadTimelineAroundLoadedWindow({
      threadId,
      priority: "immediate",
      pageSize: 500,
      olderPageCount: 3,
      direction: "older",
    });

    expect(nativeApiMock.getThreadTimelinePages).toHaveBeenCalledWith({
      threadId,
      pages: [
        expect.objectContaining({ startIndex: 8_950, limit: 500 }),
        expect.objectContaining({ startIndex: 9_450, limit: 500 }),
      ],
    });
  });

  it("caps high-velocity older prefetches by entry budget", async () => {
    mockTimelinePagesBatch(100_000);
    useTimelineWindowStore.getState().primePage(
      makeTimelinePage({
        startIndex: 97_331,
        limit: 50,
        totalItems: 100_000,
      }),
    );

    await prefetchThreadTimelineAroundLoadedWindow({
      threadId,
      priority: "immediate",
      pageSize: 4_000,
      olderPageCount: 12,
      direction: "older",
    });

    expect(nativeApiMock.getThreadTimelinePages).toHaveBeenCalledTimes(1);
    expect(nativeApiMock.getThreadTimelinePages).toHaveBeenCalledWith({
      threadId,
      pages: [
        expect.objectContaining({ startIndex: 96_331, limit: 500 }),
        expect.objectContaining({ startIndex: 96_831, limit: 500 }),
      ],
    });
  });

  it("caps dynamic slices at 500 before fetching older ranges", async () => {
    nativeApiMock.getThreadTimelinePage.mockImplementation(async (input) =>
      makeTimelinePage({
        startIndex: input.startIndex,
        limit: input.limit,
        totalItems: 10_000,
      }),
    );
    useTimelineWindowStore.getState().primePage(
      makeTimelinePage({
        startIndex: 9_000,
        limit: 100,
        totalItems: 10_000,
      }),
    );

    await prefetchThreadTimelineAroundLoadedWindow({
      threadId,
      priority: "immediate",
      pageSize: 10_000,
      direction: "older",
    });

    expect(nativeApiMock.getThreadTimelinePage.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ startIndex: 8_500, limit: 500 }),
    ]);
  });

  it("splits explicit ranges by the 500-entry request cap", async () => {
    mockTimelinePagesBatch(10_000);
    nativeApiMock.getThreadTimelinePage.mockImplementation(async (input) =>
      makeTimelinePage({
        startIndex: input.startIndex,
        limit: input.limit,
        totalItems: 10_000,
      }),
    );

    await ensureThreadTimelineRange({
      threadId,
      startIndex: 1_000,
      endIndexExclusive: 5_500,
      pageSize: 10_000,
      priority: "immediate",
    });

    expect(nativeApiMock.getThreadTimelinePage).toHaveBeenCalledWith(
      expect.objectContaining({ startIndex: 5_000, limit: 500 }),
    );
    expect(nativeApiMock.getThreadTimelinePages).toHaveBeenCalledWith({
      threadId,
      pages: [
        expect.objectContaining({ startIndex: 1_000, limit: 500 }),
        expect.objectContaining({ startIndex: 1_500, limit: 500 }),
      ],
    });
  });

  it("preserves every loaded range while rendering stays virtualized", () => {
    for (let pageIndex = 0; pageIndex < 60; pageIndex += 1) {
      useTimelineWindowStore.getState().primePage(
        makeTimelinePage({
          startIndex: pageIndex * 100,
          limit: 100,
          totalItems: 6_000,
        }),
      );
    }

    const ranges = useTimelineWindowStore.getState().loadedRangesByThreadId[threadId] ?? [];
    expect(ranges).toHaveLength(60);
    expect(ranges[0]).toMatchObject({ startIndex: 0, endIndexExclusive: 100 });
    expect(ranges.at(-1)).toMatchObject({ startIndex: 5_900, endIndexExclusive: 6_000 });
  });

  it("uses the active window even when it stores a timeline cache scope", () => {
    useTimelineWindowStore.getState().setActiveWindow(threadId, {
      startIndex: 200,
      endIndexExclusive: 300,
      overscanStartIndex: 100,
      overscanEndIndexExclusive: 400,
      updatedAt: "thread:thread-window-store:hydrated:v2",
    });

    for (let pageIndex = 0; pageIndex < 60; pageIndex += 1) {
      useTimelineWindowStore.getState().primePage(
        makeTimelinePage({
          startIndex: pageIndex * 100,
          limit: 100,
          totalItems: 6_000,
        }),
      );
    }

    const ranges = useTimelineWindowStore.getState().loadedRangesByThreadId[threadId] ?? [];
    expect(ranges).toHaveLength(60);
    expect(ranges[0]).toMatchObject({ startIndex: 0, endIndexExclusive: 100 });
    expect(ranges.some((range) => range.startIndex === 200)).toBe(true);
  });

  it("keeps newly fetched older pages from being immediately pruned", () => {
    for (let pageIndex = 0; pageIndex < 60; pageIndex += 1) {
      useTimelineWindowStore.getState().primePage(
        makeTimelinePage({
          startIndex: pageIndex * 100,
          limit: 100,
          totalItems: 6_000,
        }),
      );
    }
    useTimelineWindowStore.getState().setActiveWindow(threadId, {
      startIndex: 5_900,
      endIndexExclusive: 6_000,
      overscanStartIndex: 5_800,
      overscanEndIndexExclusive: 6_000,
      updatedAt: "thread:thread-window-store:hydrated:v2",
    });

    useTimelineWindowStore.getState().primePage(
      makeTimelinePage({
        startIndex: 0,
        limit: 100,
        totalItems: 6_000,
      }),
    );

    const ranges = useTimelineWindowStore.getState().loadedRangesByThreadId[threadId] ?? [];
    expect(ranges).toHaveLength(60);
    expect(ranges[0]).toMatchObject({ startIndex: 0, endIndexExclusive: 100 });
    expect(ranges.at(-1)).toMatchObject({ startIndex: 5_900, endIndexExclusive: 6_000 });
  });

  it("keeps the visible tail when background loading many older ultra-large ranges", () => {
    useTimelineWindowStore.getState().primePage(
      makeTimelinePage({
        startIndex: 9_900,
        limit: 100,
        totalItems: 10_000,
      }),
    );
    useTimelineWindowStore.getState().setActiveWindow(threadId, {
      startIndex: 9_900,
      endIndexExclusive: 10_000,
      overscanStartIndex: 9_880,
      overscanEndIndexExclusive: 10_000,
      updatedAt: "2026-01-01T00:00:02.000Z",
    });

    for (let pageIndex = 0; pageIndex < 60; pageIndex += 1) {
      useTimelineWindowStore.getState().primePage(
        makeTimelinePage({
          startIndex: pageIndex * 100,
          limit: 100,
          totalItems: 10_000,
        }),
      );
    }

    const ranges = useTimelineWindowStore.getState().loadedRangesByThreadId[threadId] ?? [];
    expect(ranges).toHaveLength(61);
    expect(ranges[0]).toMatchObject({ startIndex: 0, endIndexExclusive: 100 });
    expect(ranges.at(-1)).toMatchObject({ startIndex: 9_900, endIndexExclusive: 10_000 });
    expect(readLoadedThreadTimelinePages(threadId).at(-1)).toMatchObject({
      startIndex: 9_900,
      endIndexExclusive: 10_000,
    });
  });
});
