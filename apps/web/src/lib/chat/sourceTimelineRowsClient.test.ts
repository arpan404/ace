import { MessageId, TurnId, type OrchestrationMessage } from "@ace/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearCachedSourceTimelineRows,
  createSourceTimelineRowsCacheKey,
  readCachedSourceTimelineRows,
  resolveSourceTimelineRows,
} from "./sourceTimelineRowsClient";
import type { TimelineSourceRow } from "./timelineModelStore";

const turnId = TurnId.makeUnsafe("turn-native-rows-client");
const messageId = MessageId.makeUnsafe("message-native-rows-client");
const cacheKey = "rev:native-rows-client";

function createMessage(): OrchestrationMessage {
  return {
    id: messageId,
    role: "assistant",
    text: "Cached render rows",
    turnId,
    streaming: false,
    sequence: 1,
    createdAt: "2026-01-01T00:00:01.000Z",
    updatedAt: "2026-01-01T00:00:02.000Z",
  };
}

function createTimelineRow(message: OrchestrationMessage): TimelineSourceRow {
  return {
    id: `message:${message.id}`,
    kind: "message",
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    contentVersion: `v1:message:${message.id}:${message.updatedAt}`,
    startSourceIndex: 0,
    endSourceIndexExclusive: 1,
    turnId: message.turnId,
    sourceRefs: [
      {
        kind: "message",
        id: message.id,
        createdAt: message.createdAt,
        sourceIndex: 0,
        turnId: message.turnId,
        ...(message.sequence !== undefined ? { sequence: message.sequence } : {}),
      },
    ],
  };
}

afterEach(() => {
  clearCachedSourceTimelineRows(cacheKey);
  vi.unstubAllGlobals();
});

describe("sourceTimelineRowsClient", () => {
  it("creates a cache key for live rows before a complete snapshot exists", () => {
    const firstKey = createSourceTimelineRowsCacheKey({
      threadId: "thread-live-only",
      snapshotRevision: null,
      snapshotTotalRows: null,
      threadRevision: 1,
      rowCount: 1,
      rowContentKey: "message:1:v1",
      isActiveTurnRunning: true,
      activeTurnStartedAt: "2026-01-01T00:00:01.000Z",
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      hideCompletedWorkMessages: false,
      turnDiffSummaryKey: "",
    });
    const secondKey = createSourceTimelineRowsCacheKey({
      threadId: "thread-live-only",
      snapshotRevision: null,
      snapshotTotalRows: null,
      threadRevision: 2,
      rowCount: 1,
      rowContentKey: "message:1:v1",
      isActiveTurnRunning: true,
      activeTurnStartedAt: "2026-01-01T00:00:01.000Z",
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      hideCompletedWorkMessages: false,
      turnDiffSummaryKey: "",
    });

    expect(firstKey).not.toBeNull();
    expect(firstKey?.startsWith("source-timeline-rows:v8\0")).toBe(true);
    expect(firstKey).toContain("live");
    expect(secondKey).not.toBe(firstKey);
  });

  it("does not create a cache key before any timeline rows exist", () => {
    expect(
      createSourceTimelineRowsCacheKey({
        threadId: "thread-live-only",
        snapshotRevision: null,
        snapshotTotalRows: null,
        threadRevision: 1,
        rowCount: 0,
        rowContentKey: "",
        isActiveTurnRunning: true,
        activeTurnStartedAt: null,
        completionDividerBeforeEntryId: null,
        completionSummary: null,
        hideCompletedWorkMessages: false,
        turnDiffSummaryKey: "",
      }),
    ).toBeNull();
  });

  it("changes the cache key when same-count row content changes", () => {
    const baseInput = {
      threadId: "thread-live-only",
      snapshotRevision: "snapshot:1",
      snapshotTotalRows: 2,
      threadRevision: 4,
      rowCount: 2,
      isActiveTurnRunning: true,
      activeTurnStartedAt: "2026-01-01T00:00:01.000Z",
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      hideCompletedWorkMessages: false,
      turnDiffSummaryKey: "",
    };

    const firstKey = createSourceTimelineRowsCacheKey({
      ...baseInput,
      rowContentKey: "message:1:v1\0message:2:optimistic",
    });
    const secondKey = createSourceTimelineRowsCacheKey({
      ...baseInput,
      rowContentKey: "message:1:v1\0message:2:server-stream",
    });

    expect(firstKey).not.toBeNull();
    expect(secondKey).not.toBe(firstKey);
  });

  it("changes the cache key when completed work visibility changes", () => {
    const baseInput = {
      threadId: "thread-live-only",
      snapshotRevision: "snapshot:1",
      snapshotTotalRows: 2,
      threadRevision: 4,
      rowCount: 2,
      rowContentKey: "message:1:v1",
      isActiveTurnRunning: false,
      activeTurnStartedAt: null,
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      turnDiffSummaryKey: "",
    };

    const visibleKey = createSourceTimelineRowsCacheKey({
      ...baseInput,
      hideCompletedWorkMessages: false,
    });
    const hiddenKey = createSourceTimelineRowsCacheKey({
      ...baseInput,
      hideCompletedWorkMessages: true,
    });

    expect(visibleKey).not.toBeNull();
    expect(hiddenKey).not.toBe(visibleKey);
  });

  it("reuses cached render rows for an unchanged snapshot key", async () => {
    vi.stubGlobal("Worker", undefined);
    const message = createMessage();
    const rowsInput = {
      rows: [createTimelineRow(message)],
      messages: [message],
      activities: [],
      proposedPlans: [],
      activeTurnInProgress: false,
      activeTurnStartedAt: null,
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      hideCompletedWorkMessages: false,
      turnDiffSummaryByAssistantMessageId: new Map(),
    };

    const firstRows = await resolveSourceTimelineRows({ cacheKey, rowsInput });
    const secondRows = await resolveSourceTimelineRows({ cacheKey, rowsInput });

    expect(readCachedSourceTimelineRows(cacheKey)).toBe(firstRows);
    expect(secondRows).toBe(firstRows);
    expect(firstRows).toHaveLength(1);
    expect(firstRows[0]).toMatchObject({ kind: "message", id: `message:${messageId}` });
  });
});
