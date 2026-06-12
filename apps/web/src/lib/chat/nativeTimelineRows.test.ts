import {
  EventId,
  MessageId,
  TurnId,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
  type OrchestrationTimelineRow,
} from "@ace/contracts";
import { describe, expect, it } from "vitest";

import {
  buildNativeTimelineRows,
  deriveNativeCompletionDividerBeforeRowId,
} from "./nativeTimelineRows";

const turnId = TurnId.makeUnsafe("turn-native-rows");
const userMessageId = MessageId.makeUnsafe("message-user-native");
const assistantMessageId = MessageId.makeUnsafe("message-assistant-native");
const activityId = EventId.makeUnsafe("activity-native-tool");

function messageRow(message: OrchestrationMessage, sourceIndex: number): OrchestrationTimelineRow {
  return {
    id: `message:${message.id}`,
    kind: "message",
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    contentVersion: `v1:message:${message.id}:${message.updatedAt}`,
    startSourceIndex: sourceIndex,
    endSourceIndexExclusive: sourceIndex + 1,
    turnId: message.turnId,
    sourceRefs: [
      {
        kind: "message",
        id: message.id,
        createdAt: message.createdAt,
        sourceIndex,
        turnId: message.turnId,
        sequence: message.sequence,
      },
    ],
  };
}

function activityRow(
  activity: OrchestrationThreadActivity,
  sourceIndex: number,
): OrchestrationTimelineRow {
  return {
    id: `activity:${activity.id}`,
    kind: "work",
    createdAt: activity.createdAt,
    updatedAt: activity.createdAt,
    contentVersion: `v1:activity:${activity.id}`,
    startSourceIndex: sourceIndex,
    endSourceIndexExclusive: sourceIndex + 1,
    ...(activity.turnId !== null ? { turnId: activity.turnId } : {}),
    sourceRefs: [
      {
        kind: "activity",
        id: activity.id,
        createdAt: activity.createdAt,
        sourceIndex,
        ...(activity.turnId !== null ? { turnId: activity.turnId } : {}),
        ...(activity.sequence !== undefined ? { sequence: activity.sequence } : {}),
      },
    ],
  };
}

describe("nativeTimelineRows", () => {
  it("builds render rows from loaded server rows without full timeline projection", () => {
    const userMessage: OrchestrationMessage = {
      id: userMessageId,
      role: "user",
      text: "Implement this",
      turnId,
      streaming: false,
      sequence: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const assistantMessage: OrchestrationMessage = {
      id: assistantMessageId,
      role: "assistant",
      text: "Done",
      turnId,
      streaming: false,
      sequence: 2,
      createdAt: "2026-01-01T00:00:02.000Z",
      updatedAt: "2026-01-01T00:00:04.000Z",
    };
    const activity: OrchestrationThreadActivity = {
      id: activityId,
      tone: "tool",
      kind: "tool.completed",
      summary: "Ran command",
      payload: { itemType: "command_execution", command: "bun typecheck" },
      turnId,
      sequence: 3,
      createdAt: "2026-01-01T00:00:03.000Z",
    };
    const workRow = activityRow(activity, 2);

    const rows = buildNativeTimelineRows({
      rows: [messageRow(userMessage, 0), messageRow(assistantMessage, 1), workRow],
      messages: [userMessage, assistantMessage],
      activities: [activity],
      proposedPlans: [],
      activeTurnInProgress: false,
      activeTurnStartedAt: null,
      completionDividerBeforeEntryId: `message:${assistantMessageId}`,
      completionSummary: "Worked for 4s",
      turnDiffSummaryByAssistantMessageId: new Map(),
    });

    expect(rows.map((row) => row.kind)).toEqual(["message", "work-group", "message"]);
    expect(rows[1]).toMatchObject({
      kind: "work-group",
      entries: [{ id: activityId }],
    });
    expect(rows[2]).toMatchObject({
      kind: "message",
      completionSummary: "Worked for 4s",
      isAssistantTurnTerminal: true,
      showAssistantTiming: true,
    });
  });

  it("does not leak goal or context metadata activities into message timeline rows", () => {
    const goalActivity: OrchestrationThreadActivity = {
      id: EventId.makeUnsafe("activity-goal-updated"),
      tone: "info",
      kind: "goal.updated",
      summary: "Goal updated",
      payload: { goal: { objective: "Keep architecture fast" } },
      turnId,
      sequence: 1,
      createdAt: "2026-01-01T00:00:01.000Z",
    };
    const contextActivity: OrchestrationThreadActivity = {
      id: EventId.makeUnsafe("activity-context-window"),
      tone: "info",
      kind: "context-window.updated",
      summary: "Context window updated",
      payload: { maxTokens: 200000 },
      turnId,
      sequence: 2,
      createdAt: "2026-01-01T00:00:02.000Z",
    };
    const toolActivity: OrchestrationThreadActivity = {
      id: EventId.makeUnsafe("activity-visible-tool"),
      tone: "tool",
      kind: "tool.completed",
      summary: "Ran command",
      payload: { itemType: "command_execution", command: "bun typecheck" },
      turnId,
      sequence: 3,
      createdAt: "2026-01-01T00:00:03.000Z",
    };

    const rows = buildNativeTimelineRows({
      rows: [
        activityRow(goalActivity, 0),
        activityRow(contextActivity, 1),
        activityRow(toolActivity, 2),
      ],
      messages: [],
      activities: [goalActivity, contextActivity, toolActivity],
      proposedPlans: [],
      activeTurnInProgress: false,
      activeTurnStartedAt: null,
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "work-group",
      entries: [{ id: toolActivity.id }],
    });
  });

  it("groups adjacent command and thinking activities like the legacy timeline", () => {
    const commandOne: OrchestrationThreadActivity = {
      id: EventId.makeUnsafe("activity-command-one"),
      tone: "tool",
      kind: "tool.completed",
      summary: "Ran command",
      payload: { itemType: "command_execution", command: "bun lint" },
      turnId,
      sequence: 1,
      createdAt: "2026-01-01T00:00:01.000Z",
    };
    const commandTwo: OrchestrationThreadActivity = {
      id: EventId.makeUnsafe("activity-command-two"),
      tone: "tool",
      kind: "tool.completed",
      summary: "Ran command",
      payload: { itemType: "command_execution", command: "bun typecheck" },
      turnId,
      sequence: 2,
      createdAt: "2026-01-01T00:00:02.000Z",
    };
    const thinkingOne: OrchestrationThreadActivity = {
      id: EventId.makeUnsafe("activity-thinking-one"),
      tone: "info",
      kind: "task.progress",
      summary: "Thinking",
      payload: {},
      turnId,
      sequence: 3,
      createdAt: "2026-01-01T00:00:03.000Z",
    };

    const rows = buildNativeTimelineRows({
      rows: [activityRow(commandOne, 0), activityRow(commandTwo, 1), activityRow(thinkingOne, 2)],
      messages: [],
      activities: [commandOne, commandTwo, thinkingOne],
      proposedPlans: [],
      activeTurnInProgress: false,
      activeTurnStartedAt: null,
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "work-group",
      entries: [{ id: commandOne.id }, { id: commandTwo.id }, { id: thinkingOne.id }],
      summary: {
        entryCount: 3,
        toolCount: 2,
        thinkingCount: 1,
        toolSummaryCounts: {
          command: 2,
        },
      },
    });
  });

  it("derives the completion divider row from latest-turn metadata", () => {
    const assistantMessage: OrchestrationMessage = {
      id: assistantMessageId,
      role: "assistant",
      text: "Final answer",
      turnId,
      streaming: false,
      sequence: 2,
      createdAt: "2026-01-01T00:00:02.000Z",
      updatedAt: "2026-01-01T00:00:04.000Z",
    };

    expect(
      deriveNativeCompletionDividerBeforeRowId({
        latestTurn: {
          turnId,
          assistantMessageId,
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:05.000Z",
        },
        rows: [messageRow(assistantMessage, 0)],
        messages: [assistantMessage],
      }),
    ).toBe(`message:${assistantMessageId}`);
  });
});
