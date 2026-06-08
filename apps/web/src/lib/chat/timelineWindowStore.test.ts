import { EventId, MessageId, ProjectId, ThreadId, TurnId } from "@ace/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const nativeApiMock = vi.hoisted(() => ({
  getThreadTimelineManifest: vi.fn(),
  getThreadTimelinePage: vi.fn(),
}));

vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({
    orchestration: nativeApiMock,
  }),
}));

import {
  ensureThreadTimelineRange,
  prefetchThreadTimelineAroundLoadedWindow,
  prefetchThreadTimelineWindows,
  primeThreadTimelineManifestFromReadModelThread,
  readCachedThreadTimelinePage,
  readLoadedThreadTimelinePages,
  readTimelineRowHeight,
  resolveTimelineScrollPrefetchPageSize,
  useTimelineWindowStore,
  writeTimelineRowHeight,
} from "./timelineWindowStore";

const threadId = ThreadId.makeUnsafe("thread-window-store");
const turnId = TurnId.makeUnsafe("turn-window-store");

afterEach(() => {
  useTimelineWindowStore.getState().reset();
  nativeApiMock.getThreadTimelineManifest.mockReset();
  nativeApiMock.getThreadTimelinePage.mockReset();
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

describe("timelineWindowStore", () => {
  it("maps scroll velocity to exponential prefetch page sizes", () => {
    expect(resolveTimelineScrollPrefetchPageSize(0)).toBe(100);
    expect(resolveTimelineScrollPrefetchPageSize(0.74)).toBe(100);
    expect(resolveTimelineScrollPrefetchPageSize(0.75)).toBe(250);
    expect(resolveTimelineScrollPrefetchPageSize(1.5)).toBe(500);
    expect(resolveTimelineScrollPrefetchPageSize(3)).toBe(1_000);
    expect(resolveTimelineScrollPrefetchPageSize(6)).toBe(2_000);
    expect(resolveTimelineScrollPrefetchPageSize(10)).toBe(4_000);
    expect(resolveTimelineScrollPrefetchPageSize(100)).toBe(4_000);
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

  it("loads latest 50 first, then older 50 and 100 in background", async () => {
    nativeApiMock.getThreadTimelineManifest.mockResolvedValue({
      threadId,
      updatedAt: "2026-01-01T00:00:02.000Z",
      totalItems: 240,
      tailStartIndex: 112,
    });
    nativeApiMock.getThreadTimelinePage.mockImplementation(async (input) =>
      makeTimelinePage({
        startIndex: input.startIndex,
        limit: input.limit,
        totalItems: 240,
      }),
    );

    await prefetchThreadTimelineWindows({ threadId, priority: "immediate" });

    expect(nativeApiMock.getThreadTimelinePage.mock.calls[0]?.[0]).toMatchObject({
      startIndex: 190,
      limit: 50,
    });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (nativeApiMock.getThreadTimelinePage.mock.calls.length >= 3) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(nativeApiMock.getThreadTimelinePage.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ startIndex: 190, limit: 50 }),
      expect.objectContaining({ startIndex: 140, limit: 50 }),
      expect.objectContaining({ startIndex: 40, limit: 100 }),
    ]);
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
      pageSize: 1_000,
      direction: "older",
    });

    expect(nativeApiMock.getThreadTimelinePage.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ startIndex: 8_950, limit: 1_000 }),
    ]);
  });

  it("caps dynamic slices at 4000 and splits only larger caller ranges", async () => {
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
      expect.objectContaining({ startIndex: 5_000, limit: 4_000 }),
    ]);
  });

  it("splits explicit ranges only when they exceed the 4000 request cap", async () => {
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

    expect(nativeApiMock.getThreadTimelinePage.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ startIndex: 1_000, limit: 4_000 }),
      expect.objectContaining({ startIndex: 5_000, limit: 500 }),
    ]);
  });

  it("caps loaded ranges per thread so huge scrollback never renders every page", () => {
    for (let pageIndex = 0; pageIndex < 30; pageIndex += 1) {
      useTimelineWindowStore.getState().primePage(
        makeTimelinePage({
          startIndex: pageIndex * 100,
          limit: 100,
          totalItems: 3_000,
        }),
      );
    }

    const ranges = useTimelineWindowStore.getState().loadedRangesByThreadId[threadId] ?? [];
    expect(ranges).toHaveLength(24);
    expect(ranges[0]).toMatchObject({ startIndex: 600, endIndexExclusive: 700 });
    expect(ranges.at(-1)).toMatchObject({ startIndex: 2_900, endIndexExclusive: 3_000 });
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

    for (let pageIndex = 0; pageIndex < 30; pageIndex += 1) {
      useTimelineWindowStore.getState().primePage(
        makeTimelinePage({
          startIndex: pageIndex * 100,
          limit: 100,
          totalItems: 10_000,
        }),
      );
    }

    const ranges = useTimelineWindowStore.getState().loadedRangesByThreadId[threadId] ?? [];
    expect(ranges).toHaveLength(24);
    expect(ranges.at(-1)).toMatchObject({ startIndex: 9_900, endIndexExclusive: 10_000 });
    expect(readLoadedThreadTimelinePages(threadId).at(-1)).toMatchObject({
      startIndex: 9_900,
      endIndexExclusive: 10_000,
    });
  });
});
