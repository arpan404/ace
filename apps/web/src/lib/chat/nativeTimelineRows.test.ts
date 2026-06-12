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
  deriveNativeCompletionAttachment,
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
      completionStartedAt: "2026-01-01T00:00:00.000Z",
      completionEndedAt: "2026-01-01T00:00:04.000Z",
      completionTurnId: String(turnId),
      completionSummary: "Worked for 4s",
      hideCompletedWorkMessages: true,
      turnDiffSummaryByAssistantMessageId: new Map(),
    });

    expect(rows.map((row) => row.kind)).toEqual(["message", "completed-work-summary", "message"]);
    expect(rows[1]).toMatchObject({
      kind: "completed-work-summary",
      detailRows: [{ kind: "work", id: activityId }],
      toolCallCount: 1,
    });
    expect(rows[2]).toMatchObject({
      kind: "message",
      completionSummary: "Worked for 4s",
      isAssistantTurnTerminal: true,
      showAssistantTiming: true,
    });
  });

  it("groups consecutive completed work details into one expandable row", () => {
    const userMessage: OrchestrationMessage = {
      id: userMessageId,
      role: "user",
      text: "Inspect the backend",
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
      sequence: 5,
      createdAt: "2026-01-01T00:00:05.000Z",
      updatedAt: "2026-01-01T00:00:06.000Z",
    };
    const thinkingActivity: OrchestrationThreadActivity = {
      id: EventId.makeUnsafe("activity-thinking"),
      tone: "info",
      kind: "task.progress",
      summary: "Reasoning",
      payload: { detail: "Inspecting server lifecycle." },
      turnId,
      sequence: 2,
      createdAt: "2026-01-01T00:00:01.000Z",
    };
    const readActivity: OrchestrationThreadActivity = {
      id: EventId.makeUnsafe("activity-read"),
      tone: "tool",
      kind: "tool.completed",
      summary: "Read file",
      payload: { itemType: "dynamic_tool_call", title: "Read", detail: "apps/server/src/ws.ts" },
      turnId,
      sequence: 3,
      createdAt: "2026-01-01T00:00:02.000Z",
    };
    const commandActivity: OrchestrationThreadActivity = {
      id: EventId.makeUnsafe("activity-command"),
      tone: "tool",
      kind: "tool.completed",
      summary: "Ran command",
      payload: { itemType: "command_execution", command: "bun typecheck" },
      turnId,
      sequence: 4,
      createdAt: "2026-01-01T00:00:03.000Z",
    };

    const rows = buildNativeTimelineRows({
      rows: [
        messageRow(userMessage, 0),
        activityRow(thinkingActivity, 1),
        activityRow(readActivity, 2),
        activityRow(commandActivity, 3),
        messageRow(assistantMessage, 4),
      ],
      messages: [userMessage, assistantMessage],
      activities: [thinkingActivity, readActivity, commandActivity],
      proposedPlans: [],
      activeTurnInProgress: false,
      activeTurnStartedAt: null,
      completionDividerBeforeEntryId: `message:${assistantMessageId}`,
      completionStartedAt: "2026-01-01T00:00:00.000Z",
      completionEndedAt: "2026-01-01T00:00:06.000Z",
      completionTurnId: String(turnId),
      completionSummary: "Worked for 6s",
      hideCompletedWorkMessages: true,
      turnDiffSummaryByAssistantMessageId: new Map(),
    });

    expect(rows.map((row) => row.kind)).toEqual(["message", "completed-work-summary", "message"]);
    expect(rows[1]).toMatchObject({
      kind: "completed-work-summary",
      detailRows: [
        {
          kind: "work-group",
          entries: [
            { id: "activity-thinking" },
            { id: "activity-read" },
            { id: "activity-command" },
          ],
        },
      ],
      hiddenThinkingCount: 1,
      toolCallCount: 2,
    });
  });

  it("hides intermediate assistant updates inside the completed work summary", () => {
    const userMessage: OrchestrationMessage = {
      id: userMessageId,
      role: "user",
      text: "Audit the backend",
      turnId,
      streaming: false,
      sequence: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const intermediateAssistantMessage: OrchestrationMessage = {
      id: MessageId.makeUnsafe("message-assistant-native-intermediate"),
      role: "assistant",
      text: "I checked the WebSocket paths and will verify rate-limit behavior next.",
      turnId,
      streaming: false,
      sequence: 3,
      createdAt: "2026-01-01T00:00:03.000Z",
      updatedAt: "2026-01-01T00:00:03.500Z",
    };
    const finalAssistantMessage: OrchestrationMessage = {
      id: assistantMessageId,
      role: "assistant",
      text: "High-confidence backend issues found.",
      turnId,
      streaming: false,
      sequence: 5,
      createdAt: "2026-01-01T00:00:05.000Z",
      updatedAt: "2026-01-01T00:00:06.000Z",
    };
    const toolActivity: OrchestrationThreadActivity = {
      id: activityId,
      tone: "tool",
      kind: "tool.completed",
      summary: "Ran command",
      payload: { itemType: "command_execution", command: "rg WebSocket apps/server/src" },
      turnId,
      sequence: 2,
      createdAt: "2026-01-01T00:00:02.000Z",
    };
    const thinkingActivity: OrchestrationThreadActivity = {
      id: EventId.makeUnsafe("activity-native-thinking"),
      tone: "info",
      kind: "task.progress",
      summary: "Thinking",
      payload: { detail: "Preparing the final severity ordering." },
      turnId,
      sequence: 4,
      createdAt: "2026-01-01T00:00:04.000Z",
    };

    const rows = buildNativeTimelineRows({
      rows: [
        messageRow(userMessage, 0),
        activityRow(toolActivity, 1),
        messageRow(intermediateAssistantMessage, 2),
        activityRow(thinkingActivity, 3),
        messageRow(finalAssistantMessage, 4),
      ],
      messages: [userMessage, intermediateAssistantMessage, finalAssistantMessage],
      activities: [toolActivity, thinkingActivity],
      proposedPlans: [],
      activeTurnInProgress: false,
      activeTurnStartedAt: null,
      completionDividerBeforeEntryId: `message:${finalAssistantMessage.id}`,
      completionStartedAt: "2026-01-01T00:00:00.000Z",
      completionEndedAt: "2026-01-01T00:00:06.000Z",
      completionTurnId: String(turnId),
      completionSummary: "Worked for 6s",
      hideCompletedWorkMessages: true,
      turnDiffSummaryByAssistantMessageId: new Map(),
    });

    expect(rows.map((row) => row.kind)).toEqual(["message", "completed-work-summary", "message"]);
    expect(rows[1]).toMatchObject({
      kind: "completed-work-summary",
      hiddenMessageCount: 1,
      detailRows: [
        { kind: "work", id: activityId },
        {
          kind: "assistant-update",
          id: `hidden-assistant-update:${intermediateAssistantMessage.id}`,
          text: intermediateAssistantMessage.text,
        },
        { kind: "work", id: thinkingActivity.id },
      ],
    });
    expect(rows[2]).toMatchObject({
      kind: "message",
      message: { id: finalAssistantMessage.id, text: finalAssistantMessage.text },
    });
  });

  it("synthesizes completed work timing when native rows have no visible work activities", () => {
    const userMessage: OrchestrationMessage = {
      id: userMessageId,
      role: "user",
      text: "Inspect the backend",
      turnId,
      streaming: false,
      sequence: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const assistantMessage: OrchestrationMessage = {
      id: assistantMessageId,
      role: "assistant",
      text: "Backend analysis complete",
      turnId,
      streaming: false,
      sequence: 2,
      createdAt: "2026-01-01T00:00:04.000Z",
      updatedAt: "2026-01-01T00:00:10.000Z",
    };

    const rows = buildNativeTimelineRows({
      rows: [messageRow(userMessage, 0), messageRow(assistantMessage, 1)],
      messages: [userMessage, assistantMessage],
      activities: [],
      proposedPlans: [],
      activeTurnInProgress: false,
      activeTurnStartedAt: null,
      completionDividerBeforeEntryId: `message:${assistantMessageId}`,
      completionStartedAt: "2026-01-01T00:00:00.000Z",
      completionEndedAt: "2026-01-01T00:00:10.000Z",
      completionTurnId: String(turnId),
      completionSummary: "Worked for 10s",
      hideCompletedWorkMessages: true,
      turnDiffSummaryByAssistantMessageId: new Map(),
    });

    expect(rows.map((row) => row.kind)).toEqual(["message", "completed-work-summary", "message"]);
    expect(rows[1]).toMatchObject({
      kind: "completed-work-summary",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:10.000Z",
      detailRows: [],
      toolCallCount: 0,
      hiddenThinkingCount: 0,
      hiddenMessageCount: 0,
    });
  });

  it("renders completed work timing even when the assistant footer summary is unavailable", () => {
    const userMessage: OrchestrationMessage = {
      id: userMessageId,
      role: "user",
      text: "Inspect the backend",
      turnId,
      streaming: false,
      sequence: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const assistantMessage: OrchestrationMessage = {
      id: assistantMessageId,
      role: "assistant",
      text: "Backend analysis complete",
      turnId,
      streaming: false,
      sequence: 2,
      createdAt: "2026-01-01T00:00:04.000Z",
      updatedAt: "2026-01-01T00:00:10.000Z",
    };

    const rows = buildNativeTimelineRows({
      rows: [messageRow(userMessage, 0), messageRow(assistantMessage, 1)],
      messages: [userMessage, assistantMessage],
      activities: [],
      proposedPlans: [],
      activeTurnInProgress: false,
      activeTurnStartedAt: null,
      completionDividerBeforeEntryId: `message:${assistantMessageId}`,
      completionStartedAt: "2026-01-01T00:00:00.000Z",
      completionEndedAt: "2026-01-01T00:00:10.000Z",
      completionTurnId: String(turnId),
      completionSummary: null,
      hideCompletedWorkMessages: true,
      turnDiffSummaryByAssistantMessageId: new Map(),
    });

    expect(rows.map((row) => row.kind)).toEqual(["message", "completed-work-summary", "message"]);
    expect(rows[1]).toMatchObject({
      kind: "completed-work-summary",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:10.000Z",
    });
    expect(rows[2]).toMatchObject({
      kind: "message",
      completionSummary: null,
    });
  });

  it("keeps completed work details inline when completed work hiding is disabled", () => {
    const userMessage: OrchestrationMessage = {
      id: userMessageId,
      role: "user",
      text: "Audit timeline behavior",
      turnId,
      streaming: false,
      sequence: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const toolActivity: OrchestrationThreadActivity = {
      id: EventId.makeUnsafe("activity-visible-completed-tool"),
      tone: "tool",
      kind: "tool.completed",
      summary: "Ran command",
      payload: { itemType: "command_execution", command: "bun lint" },
      turnId,
      sequence: 2,
      createdAt: "2026-01-01T00:00:01.000Z",
    };
    const thinkingActivity: OrchestrationThreadActivity = {
      id: EventId.makeUnsafe("activity-visible-completed-thinking"),
      tone: "info",
      kind: "task.progress",
      summary: "Thinking",
      payload: { detail: "Checking whether completed work stays visible." },
      turnId,
      sequence: 3,
      createdAt: "2026-01-01T00:00:02.000Z",
    };
    const assistantMessage: OrchestrationMessage = {
      id: assistantMessageId,
      role: "assistant",
      text: "Done.",
      turnId,
      streaming: false,
      sequence: 4,
      createdAt: "2026-01-01T00:00:04.000Z",
      updatedAt: "2026-01-01T00:00:06.000Z",
    };

    const rows = buildNativeTimelineRows({
      rows: [
        messageRow(userMessage, 0),
        activityRow(toolActivity, 1),
        activityRow(thinkingActivity, 2),
        messageRow(assistantMessage, 3),
      ],
      messages: [userMessage, assistantMessage],
      activities: [toolActivity, thinkingActivity],
      proposedPlans: [],
      activeTurnInProgress: false,
      activeTurnStartedAt: null,
      completionDividerBeforeEntryId: `message:${assistantMessageId}`,
      completionStartedAt: "2026-01-01T00:00:00.000Z",
      completionEndedAt: "2026-01-01T00:00:06.000Z",
      completionTurnId: String(turnId),
      completionSummary: "Worked for 6s",
      hideCompletedWorkMessages: false,
      turnDiffSummaryByAssistantMessageId: new Map(),
    });

    expect(rows.map((row) => row.kind)).toEqual(["message", "work-group", "message"]);
    expect(rows.some((row) => row.kind === "completed-work-summary")).toBe(false);
    expect(rows[1]).toMatchObject({
      kind: "work-group",
      entries: [{ id: toolActivity.id }, { id: thinkingActivity.id }],
    });
    expect(rows[2]).toMatchObject({
      kind: "message",
      message: { id: assistantMessage.id },
      completionSummary: "Worked for 6s",
    });
  });

  it("hides completed native work rows behind a worked-for summary", () => {
    const userMessage: OrchestrationMessage = {
      id: userMessageId,
      role: "user",
      text: "Audit the app",
      turnId,
      streaming: false,
      sequence: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const toolActivity: OrchestrationThreadActivity = {
      id: EventId.makeUnsafe("activity-hidden-tool"),
      tone: "tool",
      kind: "tool.completed",
      summary: "Read file",
      payload: { itemType: "dynamic_tool_call", title: "Read", detail: "apps/web/src/App.tsx" },
      turnId,
      sequence: 2,
      createdAt: "2026-01-01T00:00:01.000Z",
    };
    const thinkingActivity: OrchestrationThreadActivity = {
      id: EventId.makeUnsafe("activity-hidden-thinking"),
      tone: "info",
      kind: "task.progress",
      summary: "Thinking",
      payload: { detail: "Checking completed timeline details." },
      turnId,
      sequence: 3,
      createdAt: "2026-01-01T00:00:02.000Z",
    };
    const assistantMessage: OrchestrationMessage = {
      id: assistantMessageId,
      role: "assistant",
      text: "Done.",
      turnId,
      streaming: false,
      sequence: 4,
      createdAt: "2026-01-01T00:00:04.000Z",
      updatedAt: "2026-01-01T00:00:06.000Z",
    };

    const rows = buildNativeTimelineRows({
      rows: [
        messageRow(userMessage, 0),
        activityRow(toolActivity, 1),
        activityRow(thinkingActivity, 2),
        messageRow(assistantMessage, 3),
      ],
      messages: [userMessage, assistantMessage],
      activities: [toolActivity, thinkingActivity],
      proposedPlans: [],
      activeTurnInProgress: false,
      activeTurnStartedAt: null,
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      hideCompletedWorkMessages: true,
      turnDiffSummaryByAssistantMessageId: new Map(),
    });

    expect(rows.map((row) => row.kind)).toEqual(["message", "completed-work-summary", "message"]);
    expect(rows[1]).toMatchObject({
      kind: "completed-work-summary",
      startedAt: "2026-01-01T00:00:01.000Z",
      endedAt: "2026-01-01T00:00:06.000Z",
      hiddenThinkingCount: 1,
      toolCallCount: 1,
      detailRows: [
        {
          kind: "work-group",
          entries: [{ id: toolActivity.id }, { id: thinkingActivity.id }],
        },
      ],
    });
  });

  it("hides non-terminal native assistant updates inside completed work summaries", () => {
    const userMessage: OrchestrationMessage = {
      id: userMessageId,
      role: "user",
      text: "Commit these changes",
      turnId,
      streaming: false,
      sequence: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const firstToolActivity: OrchestrationThreadActivity = {
      id: EventId.makeUnsafe("activity-commit-status"),
      tone: "tool",
      kind: "tool.completed",
      summary: "Ran command",
      payload: { itemType: "command_execution", command: "git status --short" },
      turnId,
      sequence: 2,
      createdAt: "2026-01-01T00:00:01.000Z",
    };
    const intermediateAssistantMessage: OrchestrationMessage = {
      id: MessageId.makeUnsafe("message-assistant-native-progress"),
      role: "assistant",
      text: "I will create the commit now, then open a PR.",
      turnId,
      streaming: false,
      sequence: 3,
      createdAt: "2026-01-01T00:00:02.000Z",
      updatedAt: "2026-01-01T00:00:02.500Z",
    };
    const secondToolActivity: OrchestrationThreadActivity = {
      id: EventId.makeUnsafe("activity-commit-create"),
      tone: "tool",
      kind: "tool.completed",
      summary: "Ran command",
      payload: { itemType: "command_execution", command: "git commit" },
      turnId,
      sequence: 4,
      createdAt: "2026-01-01T00:00:03.000Z",
    };
    const finalAssistantMessage: OrchestrationMessage = {
      id: assistantMessageId,
      role: "assistant",
      text: "Done.",
      turnId,
      streaming: false,
      sequence: 5,
      createdAt: "2026-01-01T00:00:04.000Z",
      updatedAt: "2026-01-01T00:00:06.000Z",
    };

    const rows = buildNativeTimelineRows({
      rows: [
        messageRow(userMessage, 0),
        activityRow(firstToolActivity, 1),
        messageRow(intermediateAssistantMessage, 2),
        activityRow(secondToolActivity, 3),
        messageRow(finalAssistantMessage, 4),
      ],
      messages: [userMessage, intermediateAssistantMessage, finalAssistantMessage],
      activities: [firstToolActivity, secondToolActivity],
      proposedPlans: [],
      activeTurnInProgress: false,
      activeTurnStartedAt: null,
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      hideCompletedWorkMessages: true,
      turnDiffSummaryByAssistantMessageId: new Map(),
    });

    expect(rows.map((row) => row.kind)).toEqual(["message", "completed-work-summary", "message"]);
    expect(rows[1]).toMatchObject({
      kind: "completed-work-summary",
      hiddenMessageCount: 1,
      toolCallCount: 2,
      detailRows: [
        { kind: "work", id: firstToolActivity.id },
        {
          kind: "assistant-update",
          id: `hidden-assistant-update:${intermediateAssistantMessage.id}`,
          text: intermediateAssistantMessage.text,
        },
        { kind: "work", id: secondToolActivity.id },
      ],
    });
    expect(rows[2]).toMatchObject({
      kind: "message",
      message: { id: finalAssistantMessage.id },
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

  it("groups prior active work while keeping only the latest activity inline", () => {
    const toolActivity: OrchestrationThreadActivity = {
      id: EventId.makeUnsafe("activity-live-tool"),
      tone: "tool",
      kind: "tool.completed",
      summary: "Used tool",
      payload: { itemType: "dynamic_tool_call", title: "Inspect files" },
      turnId,
      sequence: 1,
      createdAt: "2026-01-01T00:00:02.000Z",
    };
    const commandActivity: OrchestrationThreadActivity = {
      id: EventId.makeUnsafe("activity-live-command"),
      tone: "tool",
      kind: "tool.completed",
      summary: "Ran command",
      payload: { itemType: "command", title: "Inspect routes" },
      turnId,
      sequence: 2,
      createdAt: "2026-01-01T00:00:03.000Z",
    };
    const thinkingActivity: OrchestrationThreadActivity = {
      id: EventId.makeUnsafe("activity-live-thinking"),
      tone: "info",
      kind: "task.progress",
      summary: "Thinking",
      payload: { detail: "Reviewing the current UI state." },
      turnId,
      sequence: 3,
      createdAt: "2026-01-01T00:00:04.000Z",
    };

    const rows = buildNativeTimelineRows({
      rows: [
        activityRow(toolActivity, 0),
        activityRow(commandActivity, 1),
        activityRow(thinkingActivity, 2),
      ],
      messages: [],
      activities: [toolActivity, commandActivity, thinkingActivity],
      proposedPlans: [],
      activeTurnInProgress: true,
      activeTurnStartedAt: "2026-01-01T00:00:01.000Z",
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
    });

    expect(rows.map((row) => row.kind)).toEqual(["work-group", "work", "working"]);
    expect(rows[0]).toMatchObject({
      kind: "work-group",
      entries: [{ id: toolActivity.id }, { id: commandActivity.id }],
    });
    expect(rows[1]).toMatchObject({
      kind: "work",
      workEntry: { id: thinkingActivity.id },
    });
  });

  it("keeps active-turn work visible when row timestamps precede the active start", () => {
    const toolActivity: OrchestrationThreadActivity = {
      id: EventId.makeUnsafe("activity-live-tool-clock-skew"),
      tone: "tool",
      kind: "tool.completed",
      summary: "Ran command",
      payload: { itemType: "command", title: "Inspect workspace" },
      turnId,
      sequence: 1,
      createdAt: "2026-01-01T00:00:00.500Z",
    };
    const thinkingActivity: OrchestrationThreadActivity = {
      id: EventId.makeUnsafe("activity-live-thinking-clock-skew"),
      tone: "info",
      kind: "task.progress",
      summary: "Thinking",
      payload: { detail: "Reviewing live output." },
      turnId,
      sequence: 2,
      createdAt: "2026-01-01T00:00:00.750Z",
    };

    const rows = buildNativeTimelineRows({
      rows: [activityRow(toolActivity, 0), activityRow(thinkingActivity, 1)],
      messages: [],
      activities: [toolActivity, thinkingActivity],
      proposedPlans: [],
      activeTurnId: String(turnId),
      activeTurnInProgress: true,
      activeTurnStartedAt: "2026-01-01T00:00:01.000Z",
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      hideCompletedWorkMessages: true,
      turnDiffSummaryByAssistantMessageId: new Map(),
    });

    expect(rows.map((row) => row.kind)).toEqual(["work-group", "work", "working"]);
    expect(rows.some((row) => row.kind === "completed-work-summary")).toBe(false);
    expect(rows[0]).toMatchObject({
      kind: "work-group",
      entries: [{ id: toolActivity.id }],
    });
    expect(rows[1]).toMatchObject({
      kind: "work",
      workEntry: { id: thinkingActivity.id },
    });
  });

  it("shows a live working timer row while the active turn is running", () => {
    const activity: OrchestrationThreadActivity = {
      id: activityId,
      tone: "tool",
      kind: "tool.started",
      summary: "Used tool",
      payload: { itemType: "tool", status: "inProgress" },
      turnId,
      sequence: 2,
      createdAt: "2026-01-01T00:00:02.000Z",
    };

    const rows = buildNativeTimelineRows({
      rows: [activityRow(activity, 1)],
      messages: [],
      activities: [activity],
      proposedPlans: [],
      activeTurnInProgress: true,
      activeTurnStartedAt: "2026-01-01T00:00:01.000Z",
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
    });

    expect(rows[0]).toMatchObject({
      kind: "work",
      workEntry: { id: activityId, status: "inProgress" },
    });
    expect(rows.at(-1)).toMatchObject({
      kind: "working",
      id: "working-indicator-row",
      createdAt: "2026-01-01T00:00:01.000Z",
      mode: "live",
    });
  });

  it("keeps the active indicator in getting-started mode until agent output exists", () => {
    const userMessage: OrchestrationMessage = {
      id: userMessageId,
      role: "user",
      text: "Identify backend issues",
      turnId,
      streaming: false,
      sequence: 1,
      createdAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    };
    const activity: OrchestrationThreadActivity = {
      id: activityId,
      tone: "info",
      kind: "task.progress",
      summary: "Thinking",
      payload: {},
      turnId,
      sequence: 2,
      createdAt: "2026-01-01T00:00:03.000Z",
    };

    const gettingStartedRows = buildNativeTimelineRows({
      rows: [messageRow(userMessage, 0)],
      messages: [userMessage],
      activities: [],
      proposedPlans: [],
      activeTurnInProgress: true,
      activeTurnStartedAt: "2026-01-01T00:00:01.000Z",
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
    });
    expect(gettingStartedRows.at(-1)).toMatchObject({
      kind: "working",
      mode: "silent-thinking",
    });

    const workingRows = buildNativeTimelineRows({
      rows: [messageRow(userMessage, 0), activityRow(activity, 1)],
      messages: [userMessage],
      activities: [activity],
      proposedPlans: [],
      activeTurnInProgress: true,
      activeTurnStartedAt: "2026-01-01T00:00:01.000Z",
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
    });
    expect(workingRows.at(-1)).toMatchObject({ kind: "working", mode: "live" });
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

  it("derives a completion attachment from the terminal assistant message when turn metadata is incomplete", () => {
    const userMessage: OrchestrationMessage = {
      id: userMessageId,
      role: "user",
      text: "Inspect the backend",
      turnId,
      streaming: false,
      sequence: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const assistantMessage: OrchestrationMessage = {
      id: assistantMessageId,
      role: "assistant",
      text: "Backend analysis complete",
      turnId: null,
      streaming: false,
      sequence: 2,
      createdAt: "2026-01-01T00:00:04.000Z",
      updatedAt: "2026-01-01T00:00:10.000Z",
    };

    expect(
      deriveNativeCompletionAttachment({
        latestTurn: null,
        rows: [messageRow(userMessage, 0), messageRow(assistantMessage, 1)],
        messages: [userMessage, assistantMessage],
      }),
    ).toEqual({
      dividerBeforeEntryId: `message:${assistantMessageId}`,
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:10.000Z",
      turnId: null,
    });
  });
});
