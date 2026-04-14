import { describe, expect, it } from "vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@ace/contracts";

import {
  applyThreadAttentionState,
  type BackgroundNotificationSettings,
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
    session: null,
  };
}

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
        title: "Agent finished: Build fixes",
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
        title: "Approval needed: Build fixes",
        body: "bun lint",
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
        title: "Input needed: Build fixes",
        body: "Which scope should I handle first? (2 questions waiting)",
        deepLink: "/thread-1",
        kind: "user-input",
      },
    ]);
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
