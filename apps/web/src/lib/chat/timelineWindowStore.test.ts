import { EventId, MessageId, ProjectId, ThreadId, TurnId } from "@ace/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  primeThreadTimelineManifestFromReadModelThread,
  readCachedThreadTimelinePage,
  readTimelineRowHeight,
  useTimelineWindowStore,
  writeTimelineRowHeight,
} from "./timelineWindowStore";

const threadId = ThreadId.makeUnsafe("thread-window-store");
const turnId = TurnId.makeUnsafe("turn-window-store");

afterEach(() => {
  useTimelineWindowStore.getState().reset();
});

describe("timelineWindowStore", () => {
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
});
