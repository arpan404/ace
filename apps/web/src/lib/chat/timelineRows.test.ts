import { describe, expect, it } from "vitest";
import { MessageId, TurnId } from "@ace/contracts";

import {
  buildTimelineRows,
  isCompletedAssistantMessageRow,
  shouldWorkerizeTimelineRows,
} from "./timelineRows";
import { createMarkedProviderCommandToken } from "../../composer-editor-mentions";
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

  it("precomputes collapsed work group summary projections", () => {
    const rows = buildTimelineRows({
      timelineEntries: [
        {
          id: "intent-command",
          kind: "intent",
          createdAt: "2025-01-01T00:00:00.000Z",
          text: "Running checks",
        },
        {
          id: "command-1",
          kind: "work",
          createdAt: "2025-01-01T00:00:01.000Z",
          entry: {
            id: "command-1",
            createdAt: "2025-01-01T00:00:01.000Z",
            label: "Run command",
            requestKind: "command",
            tone: "tool",
          },
        },
        {
          id: "thinking-1",
          kind: "work",
          createdAt: "2025-01-01T00:00:02.000Z",
          entry: {
            id: "thinking-1",
            createdAt: "2025-01-01T00:00:02.000Z",
            label: "Reasoning",
            tone: "thinking",
          },
        },
      ],
      activeTurnInProgress: false,
      activeTurnStartedAt: null,
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: false,
    });

    const groupRow = rows.find((row) => row.kind === "work-group");
    expect(groupRow?.kind).toBe("work-group");
    if (groupRow?.kind !== "work-group") {
      throw new Error("Expected a work group row.");
    }

    expect(groupRow.summary).toMatchObject({
      entryCount: 3,
      intentCount: 1,
      toolCount: 1,
      thinkingCount: 1,
      hasIntentEntries: true,
      hasToolEntries: true,
      hasThinkingEntries: true,
      surfaceTone: "tool",
      threadGroupTone: "mixed",
      iconKey: "terminal",
      toolSummaryCounts: {
        command: 1,
        fileRead: 0,
        fileChange: 0,
        webSearch: 0,
        imageView: 0,
        genericTool: 0,
      },
    });
  });

  it("marks active /goal turns with goal working activity when enabled", () => {
    const rows = buildTimelineRows({
      timelineEntries: [
        {
          id: "user-goal",
          kind: "message",
          createdAt: "2025-01-01T00:00:00.000Z",
          message: {
            id: MessageId.makeUnsafe("user-goal"),
            role: "user",
            text: "/goal Ship the feature",
            createdAt: "2025-01-01T00:00:00.000Z",
            streaming: false,
          },
        },
      ],
      activeTurnInProgress: false,
      activeTurnStartedAt: null,
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      enableGoalWorkingState: true,
      isWorking: true,
    });

    expect(rows.at(-1)).toMatchObject({ kind: "working", activity: "goal" });
  });

  it("marks active decorated /goal turns with goal working activity when enabled", () => {
    const rows = buildTimelineRows({
      timelineEntries: [
        {
          id: "user-goal-decorated",
          kind: "message",
          createdAt: "2025-01-01T00:00:00.000Z",
          message: {
            id: MessageId.makeUnsafe("user-goal-decorated"),
            role: "user",
            text: `${createMarkedProviderCommandToken("goal")} Ship the feature`,
            createdAt: "2025-01-01T00:00:00.000Z",
            streaming: false,
          },
        },
      ],
      activeTurnInProgress: false,
      activeTurnStartedAt: null,
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      enableGoalWorkingState: true,
      isWorking: true,
    });

    expect(rows.at(-1)).toMatchObject({ kind: "working", activity: "goal" });
  });

  it("preserves the original active prompt as the live working timer anchor after steering", () => {
    const rows = buildTimelineRows({
      timelineEntries: [
        {
          id: "user-original",
          kind: "message",
          createdAt: "2025-01-01T00:00:00.000Z",
          message: {
            id: MessageId.makeUnsafe("user-original"),
            role: "user",
            text: "implement the feature",
            createdAt: "2025-01-01T00:00:00.000Z",
            streaming: false,
          },
        },
        {
          id: "assistant-progress",
          kind: "message",
          createdAt: "2025-01-01T00:00:20.000Z",
          message: {
            id: MessageId.makeUnsafe("assistant-progress"),
            role: "assistant",
            text: "working",
            createdAt: "2025-01-01T00:00:20.000Z",
            streaming: true,
          },
        },
        {
          id: "user-steer",
          kind: "message",
          createdAt: "2025-01-01T00:00:30.000Z",
          message: {
            id: MessageId.makeUnsafe("user-steer"),
            role: "user",
            text: "also update tests",
            createdAt: "2025-01-01T00:00:30.000Z",
            streaming: false,
          },
        },
      ],
      activeTurnInProgress: true,
      activeTurnStartedAt: "2025-01-01T00:00:00.000Z",
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: true,
    });

    expect(rows.at(-1)).toMatchObject({
      kind: "working",
      createdAt: "2025-01-01T00:00:00.000Z",
    });
  });

  it("keeps a goal turn pursuing after a later steering message", () => {
    const rows = buildTimelineRows({
      timelineEntries: [
        {
          id: "user-goal-original",
          kind: "message",
          createdAt: "2025-01-01T00:00:00.000Z",
          message: {
            id: MessageId.makeUnsafe("user-goal-original"),
            role: "user",
            text: "/goal Ship the feature",
            createdAt: "2025-01-01T00:00:00.000Z",
            streaming: false,
          },
        },
        {
          id: "user-goal-steer",
          kind: "message",
          createdAt: "2025-01-01T00:00:30.000Z",
          message: {
            id: MessageId.makeUnsafe("user-goal-steer"),
            role: "user",
            text: "include docs too",
            createdAt: "2025-01-01T00:00:30.000Z",
            streaming: false,
          },
        },
      ],
      activeTurnInProgress: true,
      activeTurnStartedAt: "2025-01-01T00:00:00.000Z",
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      enableGoalWorkingState: true,
      isWorking: true,
    });

    expect(rows.at(-1)).toMatchObject({
      kind: "working",
      activity: "goal",
      createdAt: "2025-01-01T00:00:00.000Z",
      goalStartedAt: "2025-01-01T00:00:00.000Z",
    });
  });

  it("keeps the live Codex goal timer anchored to the goal prompt across assistant rounds", () => {
    const rows = buildTimelineRows({
      timelineEntries: [
        {
          id: "user-goal-continuous",
          kind: "message",
          createdAt: "2025-01-01T00:00:00.000Z",
          message: {
            id: MessageId.makeUnsafe("user-goal-continuous"),
            role: "user",
            text: "/goal Ship the feature",
            createdAt: "2025-01-01T00:00:00.000Z",
            streaming: false,
          },
        },
        {
          id: "assistant-goal-delta-1",
          kind: "message",
          createdAt: "2025-01-01T00:00:05.000Z",
          message: {
            id: MessageId.makeUnsafe("assistant-goal-delta-1"),
            role: "assistant",
            text: "First delta.",
            createdAt: "2025-01-01T00:00:05.000Z",
            completedAt: "2025-01-01T00:00:10.000Z",
            streaming: false,
          },
        },
        {
          id: "assistant-goal-delta-2",
          kind: "message",
          createdAt: "2025-01-01T00:00:15.000Z",
          message: {
            id: MessageId.makeUnsafe("assistant-goal-delta-2"),
            role: "assistant",
            text: "Second delta.",
            createdAt: "2025-01-01T00:00:15.000Z",
            completedAt: "2025-01-01T00:00:20.000Z",
            streaming: false,
          },
        },
      ],
      activeTurnInProgress: true,
      activeTurnStartedAt: "2025-01-01T00:00:21.000Z",
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      enableGoalWorkingState: true,
      isWorking: true,
    });

    expect(rows).toContainEqual(
      expect.objectContaining({
        kind: "message",
        id: "assistant-goal-delta-1",
        isAssistantTurnTerminal: true,
      }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        kind: "message",
        id: "assistant-goal-delta-2",
        isAssistantTurnTerminal: true,
      }),
    );
    expect(rows.at(-1)).toMatchObject({
      kind: "working",
      activity: "goal",
      createdAt: "2025-01-01T00:00:21.000Z",
      goalStartedAt: "2025-01-01T00:00:00.000Z",
    });
  });

  it("stops showing the goal working activity after Codex reports goal completion", () => {
    const rows = buildTimelineRows({
      timelineEntries: [
        {
          id: "user-goal-completed",
          kind: "message",
          createdAt: "2025-01-01T00:00:00.000Z",
          message: {
            id: MessageId.makeUnsafe("user-goal-completed"),
            role: "user",
            text: "/goal Ship the feature",
            createdAt: "2025-01-01T00:00:00.000Z",
            streaming: false,
          },
        },
        {
          id: "assistant-goal-completed",
          kind: "message",
          createdAt: "2025-01-01T00:01:00.000Z",
          message: {
            id: MessageId.makeUnsafe("assistant-goal-completed"),
            role: "assistant",
            text: "Goal completed.",
            createdAt: "2025-01-01T00:01:00.000Z",
            completedAt: "2025-01-01T00:01:05.000Z",
            streaming: false,
          },
        },
      ],
      activeTurnInProgress: true,
      activeTurnStartedAt: "2025-01-01T00:01:06.000Z",
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      enableGoalWorkingState: true,
      isWorking: true,
    });

    expect(rows.at(-1)).toMatchObject({
      kind: "working",
      activity: "default",
      goalStartedAt: null,
    });
  });

  it("stops showing the goal working activity when Codex says the assistant is stopping completely", () => {
    const rows = buildTimelineRows({
      timelineEntries: [
        {
          id: "user-goal-stopping",
          kind: "message",
          createdAt: "2025-01-01T00:00:00.000Z",
          message: {
            id: MessageId.makeUnsafe("user-goal-stopping"),
            role: "user",
            text: "/goal Ship the feature",
            createdAt: "2025-01-01T00:00:00.000Z",
            streaming: false,
          },
        },
        {
          id: "assistant-stopping-completely",
          kind: "message",
          createdAt: "2025-01-01T00:01:00.000Z",
          message: {
            id: MessageId.makeUnsafe("assistant-stopping-completely"),
            role: "assistant",
            text: "Assistant stopping completely.",
            createdAt: "2025-01-01T00:01:00.000Z",
            streaming: true,
          },
        },
      ],
      activeTurnInProgress: true,
      activeTurnStartedAt: "2025-01-01T00:00:00.000Z",
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      enableGoalWorkingState: true,
      isWorking: true,
    });

    expect(rows.at(-1)).toMatchObject({
      kind: "working",
      activity: "default",
      goalStartedAt: null,
    });
  });

  it("restarts the Codex goal timer after a completed goal when a later /goal is sent", () => {
    const rows = buildTimelineRows({
      timelineEntries: [
        {
          id: "user-goal-first",
          kind: "message",
          createdAt: "2025-01-01T00:00:00.000Z",
          message: {
            id: MessageId.makeUnsafe("user-goal-first"),
            role: "user",
            text: "/goal Ship the feature",
            createdAt: "2025-01-01T00:00:00.000Z",
            streaming: false,
          },
        },
        {
          id: "assistant-goal-first-completed",
          kind: "message",
          createdAt: "2025-01-01T00:01:00.000Z",
          message: {
            id: MessageId.makeUnsafe("assistant-goal-first-completed"),
            role: "assistant",
            text: "Goal completed.",
            createdAt: "2025-01-01T00:01:00.000Z",
            completedAt: "2025-01-01T00:01:05.000Z",
            streaming: false,
          },
        },
        {
          id: "user-goal-second",
          kind: "message",
          createdAt: "2025-01-01T00:02:00.000Z",
          message: {
            id: MessageId.makeUnsafe("user-goal-second"),
            role: "user",
            text: "/goal Ship the next feature",
            createdAt: "2025-01-01T00:02:00.000Z",
            streaming: false,
          },
        },
      ],
      activeTurnInProgress: true,
      activeTurnStartedAt: "2025-01-01T00:02:00.000Z",
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      enableGoalWorkingState: true,
      isWorking: true,
    });

    expect(rows.at(-1)).toMatchObject({
      kind: "working",
      activity: "goal",
      goalStartedAt: "2025-01-01T00:02:00.000Z",
    });
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

  it("precomputes hidden completed work counts and diagnostic projections", () => {
    const rows = buildTimelineRows({
      timelineEntries: [
        {
          id: "user-before-hidden-work",
          kind: "message",
          createdAt: "2025-01-01T00:00:00.000Z",
          message: {
            id: MessageId.makeUnsafe("user-before-hidden-work"),
            role: "user",
            text: "run checks",
            createdAt: "2025-01-01T00:00:00.000Z",
            streaming: false,
          },
        },
        {
          id: "hidden-command",
          kind: "work",
          createdAt: "2025-01-01T00:00:01.000Z",
          entry: {
            id: "hidden-command",
            createdAt: "2025-01-01T00:00:01.000Z",
            label: "Run command",
            requestKind: "command",
            tone: "tool",
          },
        },
        {
          id: "hidden-thinking",
          kind: "work",
          createdAt: "2025-01-01T00:00:02.000Z",
          entry: {
            id: "hidden-thinking",
            createdAt: "2025-01-01T00:00:02.000Z",
            label: "Reasoning",
            tone: "thinking",
          },
        },
        {
          id: "hidden-warning",
          kind: "work",
          createdAt: "2025-01-01T00:00:03.000Z",
          entry: {
            id: "hidden-warning",
            createdAt: "2025-01-01T00:00:03.000Z",
            label: "Runtime warning",
            detail: "Retry scheduled",
            tone: "info",
            diagnosticKind: "runtime-warning",
          },
        },
        {
          id: "assistant-final",
          kind: "message",
          createdAt: "2025-01-01T00:00:04.000Z",
          message: {
            id: MessageId.makeUnsafe("assistant-final"),
            role: "assistant",
            text: "Done.",
            createdAt: "2025-01-01T00:00:04.000Z",
            completedAt: "2025-01-01T00:00:05.000Z",
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

    const summaryRow = rows.find((row) => row.kind === "completed-work-summary");
    expect(summaryRow?.kind).toBe("completed-work-summary");
    if (summaryRow?.kind !== "completed-work-summary") {
      throw new Error("Expected a completed work summary row.");
    }

    expect(summaryRow).toMatchObject({
      toolCallCount: 1,
      hiddenThinkingCount: 1,
      hiddenMessageCount: 0,
      visibleDiagnosticCacheKey: "hidden-warning:15:0",
      visibleDiagnosticRows: [
        expect.objectContaining({
          kind: "work",
          id: "hidden-warning",
        }),
      ],
    });
    expect(summaryRow.detailRows).toContainEqual(
      expect.objectContaining({
        kind: "work-group",
        summary: expect.objectContaining({
          toolCount: 1,
          thinkingCount: 1,
          infoCount: 1,
        }),
      }),
    );
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
