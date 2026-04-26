import { describe, expect, it } from "vitest";
import {
  CheckpointRef,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@ace/contracts";

import {
  applyThreadAttentionState,
  type BackgroundNotificationSettings,
  shouldRefreshThreadAttentionForEvent,
} from "./backgroundNotificationService";

const DEFAULT_SETTINGS: BackgroundNotificationSettings = {
  notifyOnAgentCompletion: true,
  notifyOnApprovalRequired: true,
  notifyOnUserInputRequired: true,
};

function makeActivity(input: {
  id: string;
  kind: string;
  createdAt: string;
  payload?: Record<string, unknown>;
  tone?: OrchestrationThreadActivity["tone"];
  sequence?: number;
}): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(input.id),
    kind: input.kind,
    summary: input.kind,
    tone: input.tone ?? "info",
    payload: input.payload ?? {},
    turnId: null,
    createdAt: input.createdAt,
    ...(typeof input.sequence === "number" ? { sequence: input.sequence } : {}),
  };
}

function makeThread(input: {
  id?: string;
  title?: string;
  activities?: ReadonlyArray<OrchestrationThreadActivity>;
  latestTurn?: OrchestrationThread["latestTurn"];
  messages?: OrchestrationThread["messages"];
  session?: OrchestrationThread["session"];
}): OrchestrationThread {
  return {
    id: ThreadId.makeUnsafe(input.id ?? "thread-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: input.title ?? "Build fixes",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: input.latestTurn ?? null,
    createdAt: "2026-04-14T03:00:00.000Z",
    updatedAt: "2026-04-14T03:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: input.messages ?? [],
    proposedPlans: [],
    latestProposedPlanSummary: null,
    queuedComposerMessages: [],
    queuedSteerRequest: null,
    activities: input.activities ?? [],
    checkpoints: [],
    session: input.session ?? null,
  };
}

function makeEvent<T extends OrchestrationEvent["type"]>(
  type: T,
  payload: Extract<OrchestrationEvent, { type: T }>["payload"],
  overrides: Partial<Extract<OrchestrationEvent, { type: T }>> = {},
): Extract<OrchestrationEvent, { type: T }> {
  const sequence = overrides.sequence ?? 1;
  return {
    sequence,
    eventId: EventId.makeUnsafe(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId:
      "threadId" in payload
        ? payload.threadId
        : "projectId" in payload
          ? payload.projectId
          : ProjectId.makeUnsafe("project-1"),
    occurredAt: "2026-04-14T03:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload,
    ...overrides,
  } as Extract<OrchestrationEvent, { type: T }>;
}

describe("shouldRefreshThreadAttentionForEvent", () => {
  const threadId = ThreadId.makeUnsafe("thread-1");
  const turnId = TurnId.makeUnsafe("turn-1");

  it("ignores assistant message events, including non-streaming updates", () => {
    expect(
      shouldRefreshThreadAttentionForEvent(
        makeEvent("thread.message-sent", {
          threadId,
          messageId: MessageId.makeUnsafe("message-stream"),
          role: "assistant",
          text: "partial",
          turnId,
          streaming: true,
          createdAt: "2026-04-14T03:00:01.000Z",
          updatedAt: "2026-04-14T03:00:01.000Z",
        }),
      ),
    ).toBe(false);
    expect(
      shouldRefreshThreadAttentionForEvent(
        makeEvent("thread.message-sent", {
          threadId,
          messageId: MessageId.makeUnsafe("message-final"),
          role: "assistant",
          text: "final chunk",
          turnId,
          streaming: false,
          createdAt: "2026-04-14T03:00:02.000Z",
          updatedAt: "2026-04-14T03:00:02.000Z",
        }),
      ),
    ).toBe(false);
  });

  it("refreshes for attention-related activity events", () => {
    expect(
      shouldRefreshThreadAttentionForEvent(
        makeEvent("thread.activity-appended", {
          threadId,
          activity: makeActivity({
            id: "activity-approval",
            kind: "approval.requested",
            createdAt: "2026-04-14T03:01:00.000Z",
            payload: {
              requestId: "req-1",
              requestKind: "command",
            },
          }),
        }),
      ),
    ).toBe(true);
    expect(
      shouldRefreshThreadAttentionForEvent(
        makeEvent("thread.activity-appended", {
          threadId,
          activity: makeActivity({
            id: "activity-tool",
            kind: "tool.started",
            createdAt: "2026-04-14T03:01:01.000Z",
            payload: {},
          }),
        }),
      ),
    ).toBe(false);
  });

  it("refreshes for turn lifecycle events that affect completion notifications", () => {
    expect(
      shouldRefreshThreadAttentionForEvent(
        makeEvent("thread.turn-diff-completed", {
          threadId,
          turnId,
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
          status: "ready",
          source: "git-checkpoint",
          files: [],
          assistantMessageId: MessageId.makeUnsafe("message-final"),
          completedAt: "2026-04-14T03:05:00.000Z",
        }),
      ),
    ).toBe(true);
  });
});

describe("applyThreadAttentionState", () => {
  it("emits completion notification when a turn completes in the background", () => {
    const completedAt = "2026-04-14T03:10:00.000Z";
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-1"),
        state: "completed",
        requestedAt: "2026-04-14T03:09:00.000Z",
        startedAt: "2026-04-14T03:09:05.000Z",
        completedAt,
        assistantMessageId: MessageId.makeUnsafe("message-1"),
      },
      messages: [
        {
          id: MessageId.makeUnsafe("message-1"),
          role: "assistant",
          text: "Done wiring the feature.",
          turnId: TurnId.makeUnsafe("turn-1"),
          streaming: false,
          createdAt: "2026-04-14T03:09:05.000Z",
          updatedAt: completedAt,
        },
      ],
    });

    const result = applyThreadAttentionState({
      thread,
      settings: DEFAULT_SETTINGS,
      notificationSessionStartedAt: "2026-04-14T03:00:00.000Z",
      isAppFocused: false,
    });

    expect(result.notify).toEqual([
      {
        id: "thread-1:completion:2026-04-14T03:10:00.000Z",
        title: "Build fixes finished",
        body: "Done wiring the feature.",
        deepLink: "/thread-1",
        kind: "completion",
      },
    ]);
  });

  it("does not emit completion notifications while app is focused", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-2"),
        state: "completed",
        requestedAt: "2026-04-14T03:20:00.000Z",
        startedAt: "2026-04-14T03:20:02.000Z",
        completedAt: "2026-04-14T03:20:30.000Z",
        assistantMessageId: null,
      },
    });

    const result = applyThreadAttentionState({
      thread,
      settings: DEFAULT_SETTINGS,
      notificationSessionStartedAt: "2026-04-14T03:00:00.000Z",
      isAppFocused: true,
    });

    expect(result.notify).toHaveLength(0);
  });

  it("does not emit completion notifications while the thread session is still running", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-active"),
        state: "completed",
        requestedAt: "2026-04-14T03:20:00.000Z",
        startedAt: "2026-04-14T03:20:02.000Z",
        completedAt: "2026-04-14T03:20:30.000Z",
        assistantMessageId: MessageId.makeUnsafe("message-active"),
      },
      session: {
        threadId: ThreadId.makeUnsafe("thread-1"),
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: TurnId.makeUnsafe("turn-active"),
        lastError: null,
        updatedAt: "2026-04-14T03:20:30.000Z",
      },
      messages: [
        {
          id: MessageId.makeUnsafe("message-active"),
          role: "assistant",
          text: "Interim status update.",
          turnId: TurnId.makeUnsafe("turn-active"),
          createdAt: "2026-04-14T03:20:10.000Z",
          updatedAt: "2026-04-14T03:20:30.000Z",
          streaming: false,
        },
      ],
    });

    const result = applyThreadAttentionState({
      thread,
      settings: DEFAULT_SETTINGS,
      notificationSessionStartedAt: "2026-04-14T03:00:00.000Z",
      isAppFocused: false,
    });

    expect(result.notify).toHaveLength(0);
  });

  it("emits approval notification for newly opened requests and closes resolved requests", () => {
    const requestedThread = makeThread({
      activities: [
        makeActivity({
          id: "activity-1",
          kind: "approval.requested",
          createdAt: "2026-04-14T03:30:00.000Z",
          payload: {
            requestId: "req-1",
            requestKind: "command",
            detail: "bun lint",
          },
        }),
      ],
    });

    const requestedResult = applyThreadAttentionState({
      thread: requestedThread,
      settings: DEFAULT_SETTINGS,
      notificationSessionStartedAt: "2026-04-14T03:00:00.000Z",
      isAppFocused: false,
    });

    expect(requestedResult.notify).toEqual([
      {
        id: "thread-1:req-1",
        title: "Build fixes needs approval",
        body: "Command approval: bun lint",
        deepLink: "/thread-1",
        kind: "approval",
      },
    ]);

    const resolvedThread = makeThread({
      activities: [
        makeActivity({
          id: "activity-1",
          kind: "approval.requested",
          createdAt: "2026-04-14T03:30:00.000Z",
          payload: {
            requestId: "req-1",
            requestKind: "command",
            detail: "bun lint",
          },
        }),
        makeActivity({
          id: "activity-2",
          kind: "approval.resolved",
          createdAt: "2026-04-14T03:30:05.000Z",
          payload: {
            requestId: "req-1",
          },
        }),
      ],
    });

    const resolvedResult = applyThreadAttentionState({
      thread: resolvedThread,
      previousState: requestedResult.nextState,
      settings: DEFAULT_SETTINGS,
      notificationSessionStartedAt: "2026-04-14T03:00:00.000Z",
      isAppFocused: false,
    });

    expect(resolvedResult.notify).toHaveLength(0);
    expect(resolvedResult.closeNotificationIds).toContain("thread-1:req-1");
  });

  it("suppresses approval notifications opened before the current background session", () => {
    const thread = makeThread({
      activities: [
        makeActivity({
          id: "activity-stale-approval",
          kind: "approval.requested",
          createdAt: "2026-04-14T03:29:00.000Z",
          payload: {
            requestId: "req-stale-approval",
            requestKind: "command",
            detail: "bun lint",
          },
        }),
      ],
    });

    const result = applyThreadAttentionState({
      thread,
      settings: DEFAULT_SETTINGS,
      notificationSessionStartedAt: "2026-04-14T03:30:00.000Z",
      isAppFocused: false,
    });

    expect(result.notify).toEqual([]);
    expect(result.nextState.openApprovalRequestIds).toEqual(new Set(["req-stale-approval"]));
  });

  it("emits user-input notifications for pending user-input requests", () => {
    const thread = makeThread({
      activities: [
        makeActivity({
          id: "activity-10",
          kind: "user-input.requested",
          createdAt: "2026-04-14T03:40:00.000Z",
          payload: {
            requestId: "req-input",
            questions: [
              {
                id: "scope",
                header: "Scope",
                question: "Which scope should I handle first?",
                options: [],
              },
              {
                id: "tests",
                header: "Tests",
                question: "Should I update tests?",
                options: [],
              },
            ],
          },
        }),
      ],
    });

    const result = applyThreadAttentionState({
      thread,
      settings: DEFAULT_SETTINGS,
      notificationSessionStartedAt: "2026-04-14T03:00:00.000Z",
      isAppFocused: false,
    });

    expect(result.notify).toEqual([
      {
        id: "thread-1:req-input",
        title: "Build fixes needs input",
        body: "Which scope should I handle first? (2 questions waiting)",
        deepLink: "/thread-1",
        kind: "user-input",
      },
    ]);
  });

  it("suppresses user-input notifications opened before the current background session", () => {
    const thread = makeThread({
      activities: [
        makeActivity({
          id: "activity-stale-input",
          kind: "user-input.requested",
          createdAt: "2026-04-14T03:39:00.000Z",
          payload: {
            requestId: "req-stale-input",
            questions: [
              {
                id: "scope",
                header: "Scope",
                question: "Which scope should I handle first?",
                options: [],
              },
            ],
          },
        }),
      ],
    });

    const result = applyThreadAttentionState({
      thread,
      settings: DEFAULT_SETTINGS,
      notificationSessionStartedAt: "2026-04-14T03:40:00.000Z",
      isAppFocused: false,
    });

    expect(result.notify).toEqual([]);
    expect(result.nextState.openUserInputRequestIds).toEqual(new Set(["req-stale-input"]));
  });

  it("suppresses completion notifications that happened before the service started", () => {
    const completedAt = "2026-04-14T03:00:01.000Z";
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-3"),
        state: "completed",
        requestedAt: "2026-04-14T03:00:00.000Z",
        startedAt: "2026-04-14T03:00:00.500Z",
        completedAt,
        assistantMessageId: null,
      },
    });

    const result = applyThreadAttentionState({
      thread,
      settings: DEFAULT_SETTINGS,
      notificationSessionStartedAt: "2026-04-14T03:00:02.000Z",
      isAppFocused: false,
    });

    expect(result.notify).toHaveLength(0);
    expect(result.nextState.notifiedCompletionAt).toBe(completedAt);
  });
});
