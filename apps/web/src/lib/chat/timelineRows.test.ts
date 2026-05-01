import { describe, expect, it } from "vitest";
import { MessageId } from "@ace/contracts";

import {
  buildTimelineRows,
  isCompletedAssistantMessageRow,
  shouldWorkerizeTimelineRows,
} from "./timelineRows";
import type { TimelineEntry } from "../../session-logic/types";

describe("timelineRows", () => {
  it("builds rows and appends working indicator", () => {
    const timelineEntries: TimelineEntry[] = [
      {
        id: "user-1",
        kind: "message",
        createdAt: "2025-01-01T00:00:00.000Z",
        message: {
          id: MessageId.makeUnsafe("user-1"),
          role: "user",
          text: "hi",
          createdAt: "2025-01-01T00:00:00.000Z",
          streaming: false,
        },
      },
    ];
    const rows = buildTimelineRows({
      timelineEntries,
      activeTurnInProgress: false,
      activeTurnStartedAt: null,
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: true,
    });
    expect(rows.at(-1)).toMatchObject({ kind: "working" });
  });

  it("marks completed assistant message rows", () => {
    const rows = buildTimelineRows({
      timelineEntries: [
        {
          id: "assistant-1",
          kind: "message",
          createdAt: "2025-01-01T00:00:00.000Z",
          message: {
            id: MessageId.makeUnsafe("assistant-1"),
            role: "assistant",
            text: "done",
            createdAt: "2025-01-01T00:00:00.000Z",
            streaming: false,
          },
        },
      ],
      activeTurnInProgress: false,
      activeTurnStartedAt: null,
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: false,
    });
    expect(rows.some(isCompletedAssistantMessageRow)).toBe(true);
  });

  it("workerizes large settled timelines only", () => {
    expect(
      shouldWorkerizeTimelineRows({
        timelineEntries: Array.from({ length: 80 }, (_, index) => ({
          id: `message-${index}`,
          kind: "message" as const,
          createdAt: "2025-01-01T00:00:00.000Z",
          message: {
            id: MessageId.makeUnsafe(`message-${index}`),
            role: "assistant" as const,
            text: "x".repeat(1000),
            createdAt: "2025-01-01T00:00:00.000Z",
            streaming: false,
          },
        })),
        activeTurnInProgress: false,
        activeTurnStartedAt: null,
        completionDividerBeforeEntryId: null,
        completionSummary: null,
        isWorking: false,
      }),
    ).toBe(true);
    expect(
      shouldWorkerizeTimelineRows({
        timelineEntries: [],
        activeTurnInProgress: true,
        activeTurnStartedAt: "2025-01-01T00:00:00.000Z",
        completionDividerBeforeEntryId: null,
        completionSummary: null,
        isWorking: true,
      }),
    ).toBe(false);
  });
});
