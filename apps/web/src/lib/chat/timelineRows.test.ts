import { describe, expect, it } from "vitest";
import { MessageId, TurnId } from "@ace/contracts";

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

  it("keeps image-only assistant messages", () => {
    const rows = buildTimelineRows({
      timelineEntries: [
        {
          id: "assistant-image-1",
          kind: "message",
          createdAt: "2025-01-01T00:00:00.000Z",
          message: {
            id: MessageId.makeUnsafe("assistant-image-1"),
            role: "assistant",
            text: "",
            attachments: [
              {
                type: "image",
                id: "image-1",
                name: "generated-image.png",
                mimeType: "image/png",
                sizeBytes: 24,
                previewUrl: "/attachments/image-1",
              },
            ],
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

    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("message");
    expect(rows.some(isCompletedAssistantMessageRow)).toBe(true);
  });

  it("hides completed work rows while keeping active turn work visible", () => {
    const rows = buildTimelineRows({
      timelineEntries: [
        {
          id: "completed-tool",
          kind: "work",
          createdAt: "2025-01-01T00:00:01.000Z",
          entry: {
            id: "completed-tool",
            createdAt: "2025-01-01T00:00:01.000Z",
            label: "Read file",
            detail: "README.md",
            tone: "tool",
          },
        },
        {
          id: "assistant-complete",
          kind: "message",
          createdAt: "2025-01-01T00:00:02.000Z",
          message: {
            id: MessageId.makeUnsafe("assistant-complete"),
            role: "assistant",
            text: "done",
            createdAt: "2025-01-01T00:00:02.000Z",
            completedAt: "2025-01-01T00:00:03.000Z",
            streaming: false,
          },
        },
        {
          id: "active-tool",
          kind: "work",
          createdAt: "2025-01-01T00:00:11.000Z",
          entry: {
            id: "active-tool",
            createdAt: "2025-01-01T00:00:11.000Z",
            label: "Run command",
            detail: "bun typecheck",
            tone: "tool",
          },
        },
      ],
      activeTurnInProgress: true,
      activeTurnStartedAt: "2025-01-01T00:00:10.000Z",
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      hideCompletedWorkMessages: true,
      isWorking: true,
    });

    expect(rows.some((row) => row.id === "completed-tool")).toBe(false);
    expect(rows).toContainEqual(
      expect.objectContaining({
        kind: "completed-work-summary",
        toolCallCount: 1,
        startedAt: "2025-01-01T00:00:02.000Z",
        endedAt: "2025-01-01T00:00:03.000Z",
      }),
    );
    expect(rows.some((row) => row.id === "active-tool")).toBe(true);
    expect(rows.some(isCompletedAssistantMessageRow)).toBe(true);
  });

  it("does not let hidden work before a user message inflate the next worked-for summary", () => {
    const rows = buildTimelineRows({
      timelineEntries: [
        {
          id: "old-hidden-tool",
          kind: "work",
          createdAt: "2025-01-01T00:00:00.000Z",
          entry: {
            id: "old-hidden-tool",
            createdAt: "2025-01-01T00:00:00.000Z",
            label: "Read old file",
            tone: "tool",
          },
        },
        {
          id: "user-current",
          kind: "message",
          createdAt: "2025-01-01T00:06:40.000Z",
          message: {
            id: MessageId.makeUnsafe("user-current"),
            role: "user",
            text: "add one more readme file",
            createdAt: "2025-01-01T00:06:40.000Z",
            streaming: false,
          },
        },
        {
          id: "current-hidden-tool",
          kind: "work",
          createdAt: "2025-01-01T00:06:45.000Z",
          entry: {
            id: "current-hidden-tool",
            createdAt: "2025-01-01T00:06:45.000Z",
            label: "Write file",
            tone: "tool",
          },
        },
        {
          id: "assistant-current",
          kind: "message",
          createdAt: "2025-01-01T00:06:51.000Z",
          message: {
            id: MessageId.makeUnsafe("assistant-current"),
            role: "assistant",
            text: "Done.",
            createdAt: "2025-01-01T00:06:51.000Z",
            completedAt: "2025-01-01T00:06:54.000Z",
            streaming: false,
          },
        },
      ],
      activeTurnInProgress: false,
      activeTurnStartedAt: null,
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      hideCompletedWorkMessages: true,
      isWorking: false,
    });

    expect(rows).toContainEqual(
      expect.objectContaining({
        kind: "completed-work-summary",
        startedAt: "2025-01-01T00:06:45.000Z",
        endedAt: "2025-01-01T00:06:54.000Z",
        entries: [
          expect.objectContaining({
            kind: "work",
            id: "current-hidden-tool",
          }),
        ],
        detailRows: [
          expect.objectContaining({
            kind: "work-group",
            id: "current-hidden-tool",
            entries: [
              expect.objectContaining({
                kind: "work",
                id: "current-hidden-tool",
              }),
            ],
          }),
        ],
      }),
    );
    expect(rows).not.toContainEqual(
      expect.objectContaining({
        kind: "completed-work-summary",
        startedAt: "2025-01-01T00:00:00.000Z",
      }),
    );
    const summaryRow = rows.find((row) => row.kind === "completed-work-summary");
    expect(
      summaryRow?.kind === "completed-work-summary" ? summaryRow.entries : [],
    ).not.toContainEqual(expect.objectContaining({ id: "old-hidden-tool" }));
    expect(
      summaryRow?.kind === "completed-work-summary"
        ? summaryRow.detailRows.flatMap((row) => (row.kind === "work-group" ? row.entries : []))
        : [],
    ).not.toContainEqual(expect.objectContaining({ id: "old-hidden-tool" }));
  });

  it("flushes trailing hidden completed work when no assistant message follows", () => {
    const rows = buildTimelineRows({
      timelineEntries: [
        {
          id: "user-before-runtime-error",
          kind: "message",
          createdAt: "2025-01-01T00:00:00.000Z",
          message: {
            id: MessageId.makeUnsafe("user-before-runtime-error"),
            role: "user",
            text: "continue",
            createdAt: "2025-01-01T00:00:00.000Z",
            streaming: false,
          },
        },
        {
          id: "runtime-error-final-event",
          kind: "work",
          createdAt: "2025-01-01T00:00:03.000Z",
          entry: {
            id: "runtime-error-final-event",
            createdAt: "2025-01-01T00:00:03.000Z",
            label: "Runtime error",
            detail: "rate limit",
            tone: "error",
          },
        },
      ],
      activeTurnInProgress: false,
      activeTurnStartedAt: null,
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      hideCompletedWorkMessages: true,
      isWorking: false,
    });

    expect(rows).toContainEqual(
      expect.objectContaining({
        kind: "completed-work-summary",
        startedAt: "2025-01-01T00:00:03.000Z",
        endedAt: "2025-01-01T00:00:03.000Z",
        detailRows: [
          expect.objectContaining({
            kind: "work",
            id: "runtime-error-final-event",
            workEntry: expect.objectContaining({
              tone: "error",
              detail: "rate limit",
            }),
          }),
        ],
      }),
    );
  });

  it("hides non-final completed assistant messages when completed work details are hidden", () => {
    const rows = buildTimelineRows({
      timelineEntries: [
        {
          id: "assistant-draft",
          kind: "message",
          createdAt: "2025-01-01T00:00:01.000Z",
          message: {
            id: MessageId.makeUnsafe("assistant-draft"),
            role: "assistant",
            turnId: TurnId.makeUnsafe("turn-1"),
            text: "I am checking this first.",
            createdAt: "2025-01-01T00:00:01.000Z",
            completedAt: "2025-01-01T00:00:02.000Z",
            streaming: false,
          },
        },
        {
          id: "assistant-final",
          kind: "message",
          createdAt: "2025-01-01T00:00:03.000Z",
          message: {
            id: MessageId.makeUnsafe("assistant-final"),
            role: "assistant",
            turnId: TurnId.makeUnsafe("turn-1"),
            text: "Done.",
            createdAt: "2025-01-01T00:00:03.000Z",
            completedAt: "2025-01-01T00:00:04.000Z",
            streaming: false,
          },
        },
      ],
      activeTurnInProgress: false,
      activeTurnStartedAt: null,
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      hideCompletedWorkMessages: true,
      isWorking: false,
    });

    expect(rows.some((row) => row.id === "assistant-draft")).toBe(false);
    expect(rows.some((row) => row.id === "assistant-final")).toBe(true);
    expect(rows).toContainEqual(
      expect.objectContaining({
        kind: "completed-work-summary",
        hiddenMessageCount: 1,
        startedAt: "2025-01-01T00:00:03.000Z",
        endedAt: "2025-01-01T00:00:04.000Z",
        detailRows: [
          expect.objectContaining({
            kind: "message",
            id: "assistant-draft",
            message: expect.objectContaining({
              text: "I am checking this first.",
            }),
          }),
        ],
      }),
    );
    expect(rows).toHaveLength(2);
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
