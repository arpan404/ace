import { describe, expect, it } from "vitest";
import { MessageId, type OrchestrationProposedPlanId, TurnId } from "@ace/contracts";

import { buildTimelineRows, isCompletedAssistantMessageRow } from "./timelineRows";
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
      activeTurnInProgress: true,
      activeTurnStartedAt: null,
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: true,
    });
    expect(rows.at(-1)).toMatchObject({ kind: "working", mode: "silent-thinking" });
  });

  it("switches the active indicator from getting started to working after agent output", () => {
    const turnId = TurnId.makeUnsafe("turn-working-transition");
    const userEntry: TimelineEntry = {
      id: "user-working-transition",
      kind: "message",
      createdAt: "2025-01-01T00:00:00.000Z",
      message: {
        id: MessageId.makeUnsafe("user-working-transition"),
        role: "user",
        text: "hi",
        createdAt: "2025-01-01T00:00:00.000Z",
        turnId,
        streaming: false,
      },
    };

    const gettingStartedRows = buildTimelineRows({
      timelineEntries: [userEntry],
      activeTurnInProgress: true,
      activeTurnStartedAt: "2025-01-01T00:00:00.000Z",
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: true,
    });
    expect(gettingStartedRows.at(-1)).toMatchObject({
      kind: "working",
      mode: "silent-thinking",
    });

    const workingRows = buildTimelineRows({
      timelineEntries: [
        userEntry,
        {
          id: "work-working-transition",
          kind: "work",
          createdAt: "2025-01-01T00:00:02.000Z",
          entry: {
            id: "work-working-transition",
            createdAt: "2025-01-01T00:00:02.000Z",
            turnId,
            label: "Thinking",
            tone: "thinking",
          },
        },
      ],
      activeTurnInProgress: true,
      activeTurnStartedAt: "2025-01-01T00:00:00.000Z",
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: true,
    });
    expect(workingRows.at(-1)).toMatchObject({ kind: "working", mode: "live" });
  });

  it("does not show assistant completion affordances for a still-running active turn", () => {
    const turnId = TurnId.makeUnsafe("turn-active-assistant-boundary");
    const rows = buildTimelineRows({
      timelineEntries: [
        {
          id: "assistant-active-boundary",
          kind: "message",
          createdAt: "2025-01-01T00:00:02.000Z",
          message: {
            id: MessageId.makeUnsafe("assistant-active-boundary"),
            role: "assistant",
            text: "Partial result before more tools run.",
            turnId,
            createdAt: "2025-01-01T00:00:02.000Z",
            completedAt: "2025-01-01T00:00:03.000Z",
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

    expect(rows[0]).toMatchObject({
      kind: "message",
      isAssistantTurnTerminal: true,
      showAssistantTiming: false,
      showAssistantSummaryByDefault: false,
    });
    expect(rows.at(-1)).toMatchObject({ kind: "working" });
  });

  it("does not append a working indicator without an active turn", () => {
    const rows = buildTimelineRows({
      timelineEntries: [
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
      ],
      activeTurnInProgress: false,
      activeTurnStartedAt: null,
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: true,
    });

    expect(rows.some((row) => row.kind === "working")).toBe(false);
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
      activeTurnInProgress: true,
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
      activeTurnInProgress: true,
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

  it("keeps consecutive assistant goal progress messages visible when completed work is hidden", () => {
    const turnId = TurnId.makeUnsafe("goal-progress-turn");
    const rows = buildTimelineRows({
      timelineEntries: [
        {
          id: "user-goal-progress-visible",
          kind: "message",
          createdAt: "2025-01-01T00:00:00.000Z",
          message: {
            id: MessageId.makeUnsafe("user-goal-progress-visible"),
            role: "user",
            text: "/goal Ship the feature",
            createdAt: "2025-01-01T00:00:00.000Z",
            streaming: false,
          },
        },
        {
          id: "assistant-goal-progress-1",
          kind: "message",
          createdAt: "2025-01-01T00:00:05.000Z",
          message: {
            id: MessageId.makeUnsafe("assistant-goal-progress-1"),
            role: "assistant",
            turnId,
            text: "I found the first issue.",
            createdAt: "2025-01-01T00:00:05.000Z",
            completedAt: "2025-01-01T00:00:10.000Z",
            streaming: false,
          },
        },
        {
          id: "assistant-goal-progress-2",
          kind: "message",
          createdAt: "2025-01-01T00:00:15.000Z",
          message: {
            id: MessageId.makeUnsafe("assistant-goal-progress-2"),
            role: "assistant",
            turnId,
            text: "I am applying the fix.",
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
      hideCompletedWorkMessages: true,
      isWorking: true,
    });

    expect(
      rows
        .filter((row) => row.kind === "message" && row.message.role === "assistant")
        .map((row) => row.id),
    ).toEqual(["assistant-goal-progress-1", "assistant-goal-progress-2"]);
    expect(
      rows.flatMap((row) =>
        row.kind === "message" && row.message.role === "assistant"
          ? [
              {
                id: row.id,
                isAssistantTurnTerminal: row.isAssistantTurnTerminal,
                showAssistantTiming: row.showAssistantTiming,
              },
            ]
          : [],
      ),
    ).toEqual([
      {
        id: "assistant-goal-progress-1",
        isAssistantTurnTerminal: true,
        showAssistantTiming: true,
      },
      {
        id: "assistant-goal-progress-2",
        isAssistantTurnTerminal: true,
        showAssistantTiming: true,
      },
    ]);
    expect(rows.some((row) => row.kind === "completed-work-summary")).toBe(false);
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

  it("does not render a worked-for summary for trailing work while the agent is active", () => {
    const rows = buildTimelineRows({
      timelineEntries: [
        {
          id: "active-user-before-hidden-tail",
          kind: "message",
          createdAt: "2025-01-01T00:00:00.000Z",
          message: {
            id: MessageId.makeUnsafe("active-user-before-hidden-tail"),
            role: "user",
            text: "keep going",
            createdAt: "2025-01-01T00:00:00.000Z",
            streaming: false,
          },
        },
        {
          id: "active-hidden-tool-tail",
          kind: "work",
          createdAt: "2025-01-01T00:00:01.000Z",
          entry: {
            id: "active-hidden-tool-tail",
            createdAt: "2025-01-01T00:00:01.000Z",
            label: "Edit file",
            tone: "tool",
          },
        },
      ],
      activeTurnInProgress: true,
      activeTurnStartedAt: "2025-01-01T00:00:02.000Z",
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      hideCompletedWorkMessages: true,
      isWorking: true,
    });

    expect(rows.some((row) => row.kind === "completed-work-summary")).toBe(false);
    expect(rows.at(-1)).toMatchObject({
      kind: "working",
      mode: "silent-thinking",
    });
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
      visibleDiagnosticCacheKey: "hidden-warning:0:0",
      visibleDiagnosticRows: [
        expect.objectContaining({
          kind: "work",
          id: "hidden-warning",
          workEntry: expect.not.objectContaining({
            detail: "Retry scheduled",
          }),
        }),
      ],
    });
    expect(summaryRow.detailRows).toContainEqual(
      expect.objectContaining({
        kind: "work-group",
        entries: [
          expect.objectContaining({ id: "hidden-command" }),
          expect.objectContaining({ id: "hidden-thinking" }),
          expect.objectContaining({ id: "hidden-warning" }),
        ],
        summary: expect.objectContaining({
          toolCount: 1,
          thinkingCount: 1,
          infoCount: 1,
        }),
      }),
    );
  });

  it("keeps hidden completed work unified across a proposed plan", () => {
    const turnId = TurnId.makeUnsafe("turn-hidden-work-plan");
    const rows = buildTimelineRows({
      timelineEntries: [
        {
          id: "user-before-plan-work",
          kind: "message",
          createdAt: "2025-01-01T00:00:00.000Z",
          message: {
            id: MessageId.makeUnsafe("user-before-plan-work"),
            role: "user",
            text: "Make the change",
            createdAt: "2025-01-01T00:00:00.000Z",
            turnId,
            streaming: false,
          },
        },
        {
          id: "hidden-tool-before-plan",
          kind: "work",
          createdAt: "2025-01-01T00:00:01.000Z",
          entry: {
            id: "hidden-tool-before-plan",
            createdAt: "2025-01-01T00:00:01.000Z",
            turnId,
            label: "Read file",
            tone: "tool",
          },
        },
        {
          id: "plan-between-hidden-work",
          kind: "proposed-plan",
          createdAt: "2025-01-01T00:00:02.000Z",
          proposedPlan: {
            id: "plan-between-hidden-work" as OrchestrationProposedPlanId,
            turnId,
            planMarkdown: "1. Update the implementation.\n2. Run checks.",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2025-01-01T00:00:02.000Z",
            updatedAt: "2025-01-01T00:00:02.000Z",
          },
        },
        {
          id: "hidden-tool-after-plan",
          kind: "work",
          createdAt: "2025-01-01T00:00:03.000Z",
          entry: {
            id: "hidden-tool-after-plan",
            createdAt: "2025-01-01T00:00:03.000Z",
            turnId,
            label: "Write file",
            tone: "tool",
          },
        },
        {
          id: "assistant-after-plan-work",
          kind: "message",
          createdAt: "2025-01-01T00:00:04.000Z",
          message: {
            id: MessageId.makeUnsafe("assistant-after-plan-work"),
            role: "assistant",
            text: "Done.",
            createdAt: "2025-01-01T00:00:04.000Z",
            completedAt: "2025-01-01T00:00:05.000Z",
            turnId,
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

    const summaryRows = rows.filter((row) => row.kind === "completed-work-summary");
    expect(summaryRows).toHaveLength(1);
    expect(summaryRows[0]).toMatchObject({
      kind: "completed-work-summary",
      sourceEntryIds: ["hidden-tool-before-plan", "hidden-tool-after-plan"],
      toolCallCount: 2,
    });
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
        sourceEntryIds: ["current-hidden-tool"],
        detailRows: [
          expect.objectContaining({
            kind: "work-group",
            id: "current-hidden-tool",
            entries: [expect.objectContaining({ id: "current-hidden-tool" })],
            summary: expect.objectContaining({
              toolCount: 1,
            }),
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
      summaryRow?.kind === "completed-work-summary" ? summaryRow.sourceEntryIds : [],
    ).not.toContain("old-hidden-tool");
    expect(
      summaryRow?.kind === "completed-work-summary"
        ? summaryRow.detailRows.flatMap((row) => (row.kind === "work-group" ? row.entries : []))
        : [],
    ).not.toContainEqual(expect.objectContaining({ id: "old-hidden-tool" }));
  });

  it("unifies hidden completed work across internal turn id mismatches", () => {
    const firstTurnId = TurnId.makeUnsafe("turn-hidden-unified-first");
    const secondTurnId = TurnId.makeUnsafe("turn-hidden-unified-second");
    const rows = buildTimelineRows({
      timelineEntries: [
        {
          id: "user-hidden-unified",
          kind: "message",
          createdAt: "2025-01-01T00:00:00.000Z",
          message: {
            id: MessageId.makeUnsafe("user-hidden-unified"),
            role: "user",
            text: "run the checks",
            createdAt: "2025-01-01T00:00:00.000Z",
            streaming: false,
          },
        },
        {
          id: "hidden-ui-group",
          kind: "work",
          createdAt: "2025-01-01T00:00:01.000Z",
          entry: {
            id: "hidden-ui-group",
            createdAt: "2025-01-01T00:00:01.000Z",
            turnId: firstTurnId,
            label: "Update UI group",
            tone: "tool",
          },
        },
        {
          id: "hidden-tool-group",
          kind: "work",
          createdAt: "2025-01-01T00:00:02.000Z",
          entry: {
            id: "hidden-tool-group",
            createdAt: "2025-01-01T00:00:02.000Z",
            turnId: secondTurnId,
            label: "Run command",
            requestKind: "command",
            tone: "tool",
          },
        },
        {
          id: "assistant-hidden-unified",
          kind: "message",
          createdAt: "2025-01-01T00:00:03.000Z",
          message: {
            id: MessageId.makeUnsafe("assistant-hidden-unified"),
            role: "assistant",
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

    const summaryRows = rows.filter((row) => row.kind === "completed-work-summary");
    expect(summaryRows).toHaveLength(1);
    expect(summaryRows[0]).toMatchObject({
      kind: "completed-work-summary",
      startedAt: "2025-01-01T00:00:01.000Z",
      endedAt: "2025-01-01T00:00:04.000Z",
      sourceEntryIds: ["hidden-ui-group", "hidden-tool-group"],
      toolCallCount: 2,
    });
  });

  it("keeps hidden trailing work before the next user message", () => {
    const turnId = TurnId.makeUnsafe("turn-trailing-work");
    const rows = buildTimelineRows({
      timelineEntries: [
        {
          id: "user-first",
          kind: "message",
          createdAt: "2025-01-01T00:00:00.000Z",
          message: {
            id: MessageId.makeUnsafe("user-first"),
            role: "user",
            text: "run checks",
            createdAt: "2025-01-01T00:00:00.000Z",
            streaming: false,
          },
        },
        {
          id: "assistant-before-trailing-work",
          kind: "message",
          createdAt: "2025-01-01T00:00:01.000Z",
          message: {
            id: MessageId.makeUnsafe("assistant-before-trailing-work"),
            role: "assistant",
            turnId,
            text: "Checks are running.",
            createdAt: "2025-01-01T00:00:01.000Z",
            completedAt: "2025-01-01T00:00:02.000Z",
            streaming: false,
          },
        },
        {
          id: "trailing-tool",
          kind: "work",
          createdAt: "2025-01-01T00:00:03.000Z",
          entry: {
            id: "trailing-tool",
            createdAt: "2025-01-01T00:00:03.000Z",
            turnId,
            label: "Run command",
            requestKind: "command",
            tone: "tool",
          },
        },
        {
          id: "user-second",
          kind: "message",
          createdAt: "2025-01-01T00:00:10.000Z",
          message: {
            id: MessageId.makeUnsafe("user-second"),
            role: "user",
            text: "continue",
            createdAt: "2025-01-01T00:00:10.000Z",
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

    expect(rows.map((row) => row.id)).toEqual([
      "user-first",
      "assistant-before-trailing-work",
      "completed-work-summary:trailing-tool",
      "user-second",
    ]);
    expect(rows[2]).toMatchObject({
      kind: "completed-work-summary",
      startedAt: "2025-01-01T00:00:03.000Z",
      endedAt: "2025-01-01T00:00:03.000Z",
      sourceEntryIds: ["trailing-tool"],
    });
  });

  it("splits adjacent event groups when their turn ids differ", () => {
    const firstTurnId = TurnId.makeUnsafe("turn-event-first");
    const secondTurnId = TurnId.makeUnsafe("turn-event-second");
    const rows = buildTimelineRows({
      timelineEntries: [
        {
          id: "first-turn-tool",
          kind: "work",
          createdAt: "2025-01-01T00:00:01.000Z",
          entry: {
            id: "first-turn-tool",
            createdAt: "2025-01-01T00:00:01.000Z",
            turnId: firstTurnId,
            label: "Read file",
            tone: "tool",
          },
        },
        {
          id: "second-turn-tool",
          kind: "work",
          createdAt: "2025-01-01T00:00:02.000Z",
          entry: {
            id: "second-turn-tool",
            createdAt: "2025-01-01T00:00:02.000Z",
            turnId: secondTurnId,
            label: "Run command",
            tone: "tool",
          },
        },
      ],
      activeTurnInProgress: false,
      activeTurnStartedAt: null,
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: false,
    });

    expect(rows).toHaveLength(2);
    expect(rows).toEqual([
      expect.objectContaining({
        kind: "work-group",
        id: "first-turn-tool",
        entries: [expect.objectContaining({ id: "first-turn-tool" })],
      }),
      expect.objectContaining({
        kind: "work-group",
        id: "second-turn-tool",
        entries: [expect.objectContaining({ id: "second-turn-tool" })],
      }),
    ]);
  });

  it("splits pending intent groups from following tools when their turn ids differ", () => {
    const firstTurnId = TurnId.makeUnsafe("turn-intent-first");
    const secondTurnId = TurnId.makeUnsafe("turn-intent-second");
    const rows = buildTimelineRows({
      timelineEntries: [
        {
          id: "intent-first-turn",
          kind: "intent",
          createdAt: "2025-01-01T00:00:01.000Z",
          turnId: firstTurnId,
          text: "Inspecting the previous result",
        },
        {
          id: "second-turn-tool",
          kind: "work",
          createdAt: "2025-01-01T00:00:02.000Z",
          entry: {
            id: "second-turn-tool",
            createdAt: "2025-01-01T00:00:02.000Z",
            turnId: secondTurnId,
            label: "Run command",
            tone: "tool",
          },
        },
      ],
      activeTurnInProgress: false,
      activeTurnStartedAt: null,
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: false,
    });

    expect(rows).toEqual([
      expect.objectContaining({
        kind: "work-group",
        id: "intent-first-turn",
        entries: [expect.objectContaining({ id: "intent-first-turn" })],
      }),
      expect.objectContaining({
        kind: "work-group",
        id: "second-turn-tool",
        entries: [expect.objectContaining({ id: "second-turn-tool" })],
      }),
    ]);
  });

  it("omits runtime error work from the message timeline", () => {
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
            diagnosticKind: "runtime-error",
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

    expect(rows.map((row) => row.id)).toEqual(["user-before-runtime-error"]);
    expect(rows.some((row) => row.kind === "completed-work-summary")).toBe(false);
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
            kind: "assistant-update",
            id: "hidden-assistant-update:assistant-draft",
            text: "I am checking this first.",
            truncated: false,
          }),
        ],
      }),
    );
    expect(rows).toHaveLength(2);
  });

  it("preserves hidden assistant update and tool group order inside completed work details", () => {
    const turnId = TurnId.makeUnsafe("turn-ordered-details");
    const rows = buildTimelineRows({
      timelineEntries: [
        {
          id: "assistant-update-one",
          kind: "message",
          createdAt: "2025-01-01T00:00:01.000Z",
          message: {
            id: MessageId.makeUnsafe("assistant-update-one"),
            role: "assistant",
            turnId,
            text: "I am checking the repo first.",
            createdAt: "2025-01-01T00:00:01.000Z",
            completedAt: "2025-01-01T00:00:02.000Z",
            streaming: false,
          },
        },
        {
          id: "hidden-command",
          kind: "work",
          createdAt: "2025-01-01T00:00:03.000Z",
          entry: {
            id: "hidden-command",
            turnId,
            createdAt: "2025-01-01T00:00:03.000Z",
            label: "Run command",
            requestKind: "command",
            tone: "tool",
          },
        },
        {
          id: "assistant-update-two",
          kind: "message",
          createdAt: "2025-01-01T00:00:04.000Z",
          message: {
            id: MessageId.makeUnsafe("assistant-update-two"),
            role: "assistant",
            turnId,
            text: "I confirmed the scripts and I am checking packages next.",
            createdAt: "2025-01-01T00:00:04.000Z",
            completedAt: "2025-01-01T00:00:05.000Z",
            streaming: false,
          },
        },
        {
          id: "assistant-final",
          kind: "message",
          createdAt: "2025-01-01T00:00:06.000Z",
          message: {
            id: MessageId.makeUnsafe("assistant-final"),
            role: "assistant",
            turnId,
            text: "Done.",
            createdAt: "2025-01-01T00:00:06.000Z",
            completedAt: "2025-01-01T00:00:07.000Z",
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

    expect(summaryRow.detailRows.map((row) => row.id)).toEqual([
      "hidden-assistant-update:assistant-update-one",
      "hidden-command",
      "hidden-assistant-update:assistant-update-two",
    ]);
    expect(summaryRow.detailRows).toMatchObject([
      {
        kind: "assistant-update",
        text: "I am checking the repo first.",
      },
      {
        kind: "work-group",
        summary: expect.objectContaining({
          toolCount: 1,
          toolSummaryCounts: expect.objectContaining({
            command: 1,
          }),
        }),
      },
      {
        kind: "assistant-update",
        text: "I confirmed the scripts and I am checking packages next.",
      },
    ]);
  });
});
