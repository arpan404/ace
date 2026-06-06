import {
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@ace/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveCompletionDividerBeforeEntryId,
  deriveActiveWorkStartedAt,
  deriveActiveGoalState,
  deriveEnvironmentMcpStatuses,
  deriveEnvironmentProviderStatuses,
  deriveEnvironmentSessionProviderStatus,
  deriveEnvironmentSessionProviderStatuses,
  deriveActivePlanState,
  deriveLatestGeneratedWorkspaceSummary,
  deriveVisibleWorkTurnId,
  deriveVisibleTurnDiffSummaryByAssistantMessageId,
  PROVIDER_OPTIONS,
  derivePendingApprovals,
  derivePendingUserInputs,
  deriveTimelineEntries,
  deriveWorkLogEntries,
  filterMainTimelineMessages,
  filterMainTimelineWorkLogEntries,
  filterVisibleWorkLogActivities,
  findLatestProposedPlan,
  findSidebarProposedPlan,
  hasActionableProposedPlan,
  hasToolActivityForTurn,
  isLatestTurnSettled,
  summarizeActivePlan,
} from "./session-logic";

function makeActivity(overrides: {
  id?: string;
  createdAt?: string;
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  turnId?: string;
  sequence?: number;
}): OrchestrationThreadActivity {
  const payload = overrides.payload ?? {};
  return {
    id: EventId.makeUnsafe(overrides.id ?? crypto.randomUUID()),
    createdAt: overrides.createdAt ?? "2026-02-23T00:00:00.000Z",
    kind: overrides.kind ?? "tool.started",
    summary: overrides.summary ?? "Tool call",
    tone: overrides.tone ?? "tool",
    payload,
    turnId: overrides.turnId ? TurnId.makeUnsafe(overrides.turnId) : null,
    ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
  };
}

describe("derivePendingApprovals", () => {
  it("tracks open approvals and removes resolved ones", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-1",
          requestKind: "command",
          detail: "bun run lint",
        },
      }),
      makeActivity({
        id: "approval-close",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "approval.resolved",
        summary: "Approval resolved",
        tone: "info",
        payload: { requestId: "req-2" },
      }),
      makeActivity({
        id: "approval-closed-request",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "approval.requested",
        summary: "File-change approval requested",
        tone: "approval",
        payload: { requestId: "req-2", requestKind: "file-change" },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-1",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "bun run lint",
      },
    ]);
  });

  it("maps canonical requestType payloads into pending approvals", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-request-type",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-request-type",
          requestType: "command_execution_approval",
          detail: "pwd",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-request-type",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "pwd",
      },
    ]);
  });

  it("keeps approval source metadata for subagent approval banners", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-source",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-source",
          requestType: "command_execution_approval",
          detail: "bun run lint",
          sourceThreadId: "codex-child-thread-1",
          sourceThreadLabel: "Noether Nullguard",
          sourceAgentId: "reviewer",
          sourceAgentName: "Noether Nullguard",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-source",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "bun run lint",
        sourceThreadId: "codex-child-thread-1",
        sourceThreadLabel: "Noether Nullguard",
        sourceAgentId: "reviewer",
        sourceAgentName: "Noether Nullguard",
      },
    ]);
  });

  it("clears stale pending approvals when provider reports unknown pending request", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-stale",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-stale-1",
          requestKind: "command",
        },
      }),
      makeActivity({
        id: "approval-failed-stale",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        tone: "error",
        payload: {
          requestId: "req-stale-1",
          detail: "Unknown pending permission request: req-stale-1",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([]);
  });

  it("clears stale pending approvals when the backend marks them stale after restart", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-stale-restart",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-stale-restart-1",
          requestKind: "command",
        },
      }),
      makeActivity({
        id: "approval-failed-stale-restart",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        tone: "error",
        payload: {
          requestId: "req-stale-restart-1",
          detail:
            "Stale pending approval request: req-stale-restart-1. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([]);
  });
});

describe("derivePendingUserInputs", () => {
  it("tracks open structured prompts and removes resolved ones", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-1",
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
            },
          ],
        },
      }),
      makeActivity({
        id: "user-input-resolved",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "user-input.resolved",
        summary: "User input submitted",
        tone: "info",
        payload: {
          requestId: "req-user-input-2",
          answers: {
            sandbox_mode: "workspace-write",
          },
        },
      }),
      makeActivity({
        id: "user-input-open-2",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-2",
          questions: [
            {
              id: "approval",
              header: "Approval",
              question: "Continue?",
              options: [
                {
                  label: "yes",
                  description: "Continue execution",
                },
              ],
            },
          ],
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)).toEqual([
      {
        requestId: "req-user-input-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow workspace writes only",
              },
            ],
          },
        ],
      },
    ]);
  });

  it("clears stale pending user-input prompts when the provider reports an orphaned request", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open-stale",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-stale-1",
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
            },
          ],
        },
      }),
      makeActivity({
        id: "user-input-failed-stale",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.user-input.respond.failed",
        summary: "Provider user input response failed",
        tone: "error",
        payload: {
          requestId: "req-user-input-stale-1",
          detail:
            "Stale pending user-input request: req-user-input-stale-1. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.",
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)).toEqual([]);
  });

  it("keeps freeform user-input prompts without predefined options", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open-freeform",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-freeform",
          questions: [
            {
              id: "scope",
              header: "Scope",
              question: "What should this change cover?",
              options: [],
            },
          ],
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)).toEqual([
      {
        requestId: "req-user-input-freeform",
        createdAt: "2026-02-23T00:00:02.000Z",
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "What should this change cover?",
            options: [],
          },
        ],
      },
    ]);
  });

  it("normalizes option descriptions when providers omit them", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open-missing-description",
        createdAt: "2026-02-23T00:00:02.500Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-missing-description",
          questions: [
            {
              id: "mode",
              header: "Mode",
              question: "Pick one",
              options: [{ label: "safe" }],
            },
          ],
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)).toEqual([
      {
        requestId: "req-user-input-missing-description",
        createdAt: "2026-02-23T00:00:02.500Z",
        questions: [
          {
            id: "mode",
            header: "Mode",
            question: "Pick one",
            options: [{ label: "safe", description: "safe" }],
          },
        ],
      },
    ]);
  });

  it("preserves multi-select question metadata for open prompts", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open-multi",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-multi",
          questions: [
            {
              id: "tools",
              header: "Tools",
              question: "Which tools should run?",
              multiSelect: true,
              options: [
                {
                  label: "Search",
                  description: "Run search",
                },
                {
                  label: "Edit",
                  description: "Run edits",
                },
              ],
            },
          ],
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)).toEqual([
      {
        requestId: "req-user-input-multi",
        createdAt: "2026-02-23T00:00:03.000Z",
        questions: [
          {
            id: "tools",
            header: "Tools",
            question: "Which tools should run?",
            multiSelect: true,
            options: [
              {
                label: "Search",
                description: "Run search",
              },
              {
                label: "Edit",
                description: "Run edits",
              },
            ],
          },
        ],
      },
    ]);
  });
});

describe("deriveActivePlanState", () => {
  it("returns the latest plan update for the active turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "plan-old",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          explanation: "Initial plan",
          plan: [{ step: "Inspect code", status: "pending" }],
        },
      }),
      makeActivity({
        id: "plan-latest",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          explanation: "Refined plan",
          plan: [{ step: "Implement Codex user input", status: "inProgress" }],
        },
      }),
    ];

    expect(deriveActivePlanState(activities, TurnId.makeUnsafe("turn-1"))).toEqual({
      createdAt: "2026-02-23T00:00:02.000Z",
      turnId: "turn-1",
      source: "plan-update",
      explanation: "Refined plan",
      steps: [{ step: "Implement Codex user input", status: "inProgress" }],
    });
  });

  it("falls back to the latest provider todo update when the active turn has none", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "plan-turn-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          plan: [{ step: "Collect requirements", status: "completed" }],
        },
      }),
      makeActivity({
        id: "plan-turn-2",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-2",
        payload: {
          plan: [{ step: "Implement UI fixes", status: "inProgress" }],
        },
      }),
    ];

    expect(deriveActivePlanState(activities, TurnId.makeUnsafe("turn-3"))).toEqual({
      createdAt: "2026-02-23T00:00:02.000Z",
      turnId: "turn-2",
      source: "plan-update",
      steps: [{ step: "Implement UI fixes", status: "inProgress" }],
    });
  });

  it("uses turnless provider todo updates while a turn is active", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "plan-turn-scoped",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          plan: [{ step: "Draft implementation", status: "inProgress" }],
        },
      }),
      makeActivity({
        id: "plan-turnless-latest",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        payload: {
          plan: [{ step: "Draft implementation", status: "completed" }],
        },
      }),
    ];

    expect(deriveActivePlanState(activities, TurnId.makeUnsafe("turn-1"))).toEqual({
      createdAt: "2026-02-23T00:00:02.000Z",
      turnId: null,
      source: "plan-update",
      steps: [{ step: "Draft implementation", status: "completed" }],
    });
  });

  it("does not treat task activity as plan data when no explicit plan update exists", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        summary: "Plan task started",
        tone: "info",
        turnId: "turn-2",
        payload: {
          taskId: "task-1",
          taskType: "plan",
          detail: "Patch GitHub Copilot Adapter",
        },
      }),
      makeActivity({
        id: "task-progress",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Reasoning update",
        tone: "info",
        turnId: "turn-2",
        payload: {
          taskId: "task-1",
          detail: "Patch GitHub Copilot Adapter",
          summary: "Applying the adapter changes",
        },
      }),
    ];

    expect(deriveActivePlanState(activities, TurnId.makeUnsafe("turn-2"))).toBeNull();
  });
});

describe("findLatestProposedPlan", () => {
  it("prefers the latest proposed plan for the active turn", () => {
    expect(
      findLatestProposedPlan(
        [
          {
            id: "plan:thread-1:turn:turn-1",
            turnId: TurnId.makeUnsafe("turn-1"),
            planMarkdown: "# Older",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:01.000Z",
            updatedAt: "2026-02-23T00:00:01.000Z",
          },
          {
            id: "plan:thread-1:turn:turn-1",
            turnId: TurnId.makeUnsafe("turn-1"),
            planMarkdown: "# Latest",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:01.000Z",
            updatedAt: "2026-02-23T00:00:02.000Z",
          },
          {
            id: "plan:thread-1:turn:turn-2",
            turnId: TurnId.makeUnsafe("turn-2"),
            planMarkdown: "# Different turn",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:03.000Z",
            updatedAt: "2026-02-23T00:00:03.000Z",
          },
        ],
        TurnId.makeUnsafe("turn-1"),
      ),
    ).toEqual({
      id: "plan:thread-1:turn:turn-1",
      turnId: "turn-1",
      planMarkdown: "# Latest",
      implementedAt: null,
      implementationThreadId: null,
      createdAt: "2026-02-23T00:00:01.000Z",
      updatedAt: "2026-02-23T00:00:02.000Z",
    });
  });

  it("falls back to the most recently updated proposed plan", () => {
    const latestPlan = findLatestProposedPlan(
      [
        {
          id: "plan:thread-1:turn:turn-1",
          turnId: TurnId.makeUnsafe("turn-1"),
          planMarkdown: "# First",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:01.000Z",
          updatedAt: "2026-02-23T00:00:01.000Z",
        },
        {
          id: "plan:thread-1:turn:turn-2",
          turnId: TurnId.makeUnsafe("turn-2"),
          planMarkdown: "# Latest",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:03.000Z",
        },
      ],
      null,
    );

    expect(latestPlan?.planMarkdown).toBe("# Latest");
  });
});

describe("summarizeActivePlan", () => {
  it("prefers the in-progress step for current progress", () => {
    expect(
      summarizeActivePlan({
        steps: [
          { step: "Audit", status: "completed" },
          { step: "Implement", status: "inProgress" },
          { step: "Verify", status: "pending" },
        ],
      }),
    ).toEqual({
      total: 3,
      completed: 1,
      currentIndex: 2,
      currentStep: "Implement",
      currentStatus: "inProgress",
    });
  });

  it("falls back to the first pending step when work is ready but not started", () => {
    expect(
      summarizeActivePlan({
        steps: [
          { step: "Audit", status: "completed" },
          { step: "Implement", status: "pending" },
          { step: "Verify", status: "pending" },
        ],
      }),
    ).toEqual({
      total: 3,
      completed: 1,
      currentIndex: 2,
      currentStep: "Implement",
      currentStatus: "pending",
    });
  });
});

describe("hasActionableProposedPlan", () => {
  it("returns true for an unimplemented proposed plan", () => {
    expect(
      hasActionableProposedPlan({
        id: "plan-1",
        turnId: TurnId.makeUnsafe("turn-1"),
        planMarkdown: "# Plan",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:01.000Z",
      }),
    ).toBe(true);
  });

  it("returns false for a proposed plan already implemented elsewhere", () => {
    expect(
      hasActionableProposedPlan({
        id: "plan-1",
        turnId: TurnId.makeUnsafe("turn-1"),
        planMarkdown: "# Plan",
        implementedAt: "2026-02-23T00:00:02.000Z",
        implementationThreadId: ThreadId.makeUnsafe("thread-implement"),
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:02.000Z",
      }),
    ).toBe(false);
  });
});

describe("findSidebarProposedPlan", () => {
  it("prefers the running turn source proposed plan when available on the same thread", () => {
    expect(
      findSidebarProposedPlan({
        threads: [
          {
            id: ThreadId.makeUnsafe("thread-1"),
            proposedPlans: [
              {
                id: "plan-1",
                turnId: TurnId.makeUnsafe("turn-plan"),
                planMarkdown: "# Source plan",
                implementedAt: "2026-02-23T00:00:03.000Z",
                implementationThreadId: ThreadId.makeUnsafe("thread-2"),
                createdAt: "2026-02-23T00:00:01.000Z",
                updatedAt: "2026-02-23T00:00:02.000Z",
              },
            ],
          },
          {
            id: ThreadId.makeUnsafe("thread-2"),
            proposedPlans: [
              {
                id: "plan-2",
                turnId: TurnId.makeUnsafe("turn-other"),
                planMarkdown: "# Latest elsewhere",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:04.000Z",
                updatedAt: "2026-02-23T00:00:05.000Z",
              },
            ],
          },
        ],
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-implementation"),
          sourceProposedPlan: {
            threadId: ThreadId.makeUnsafe("thread-1"),
            planId: "plan-1",
          },
        },
        latestTurnSettled: false,
        threadId: ThreadId.makeUnsafe("thread-1"),
      }),
    ).toEqual({
      id: "plan-1",
      turnId: "turn-plan",
      planMarkdown: "# Source plan",
      implementedAt: "2026-02-23T00:00:03.000Z",
      implementationThreadId: "thread-2",
      createdAt: "2026-02-23T00:00:01.000Z",
      updatedAt: "2026-02-23T00:00:02.000Z",
    });
  });

  it("falls back to the latest proposed plan once the turn is settled", () => {
    expect(
      findSidebarProposedPlan({
        threads: [
          {
            id: ThreadId.makeUnsafe("thread-1"),
            proposedPlans: [
              {
                id: "plan-1",
                turnId: TurnId.makeUnsafe("turn-plan"),
                planMarkdown: "# Older",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:01.000Z",
                updatedAt: "2026-02-23T00:00:02.000Z",
              },
              {
                id: "plan-2",
                turnId: TurnId.makeUnsafe("turn-latest"),
                planMarkdown: "# Latest",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:03.000Z",
                updatedAt: "2026-02-23T00:00:04.000Z",
              },
            ],
          },
        ],
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-implementation"),
          sourceProposedPlan: {
            threadId: ThreadId.makeUnsafe("thread-1"),
            planId: "plan-1",
          },
        },
        latestTurnSettled: true,
        threadId: ThreadId.makeUnsafe("thread-1"),
      })?.planMarkdown,
    ).toBe("# Latest");
  });
});

describe("deriveWorkLogEntries", () => {
  it("does not render provider goal updates in the work log", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "goal-updated",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "goal.updated",
        summary: "Goal updated",
        tone: "info",
        payload: {
          threadId: "provider-thread-1",
          objective: "Ship provider goal UI",
          status: "active",
          detail: "Ship provider goal UI",
        },
      }),
      makeActivity({
        id: "goal-cleared",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "goal.cleared",
        summary: "Goal cleared",
        tone: "info",
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)).toEqual([]);
  });

  it("does not render goal lifecycle tool activity in the work log", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "goal-tool-completed",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.completed",
        summary: "Goal updated",
        tone: "tool",
        payload: {
          detail: "Ship provider goal UI",
          status: "active",
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)).toEqual([]);
  });

  it("does not render normalized goal tool results in the work log", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "goal-tool-name-completed",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.completed",
        summary: "Tool call complete",
        tone: "tool",
        payload: {
          title: "update_goal",
          detail: "Implement provider feature parity",
          data: {
            name: "update_goal",
            result: {
              objective: "Implement provider feature parity",
              status: "active",
            },
          },
        },
      }),
      makeActivity({
        id: "goal-tool-payload-completed",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call complete",
        tone: "tool",
        payload: {
          detail: "Implement provider feature parity",
          objective: "Implement provider feature parity",
          status: "paused",
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)).toEqual([]);
  });

  it("does not render nested goal lifecycle tool items in the work log", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "goal-nested-item",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.progress",
        summary: "Thinking",
        tone: "info",
        payload: {
          data: {
            item: {
              title: "Goal updated",
              input: {
                objective: "Implement provider feature parity",
                status: "active",
              },
            },
          },
        },
      }),
      makeActivity({
        id: "goal-nested-result",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "reasoning.completed",
        summary: "Thinking",
        tone: "info",
        payload: {
          data: {
            item: {
              output: {
                objective: "Implement provider feature parity",
                status: "paused",
              },
            },
          },
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)).toEqual([]);
  });

  it("does not render deeply nested goal lifecycle items inside thinking payloads", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "goal-nested-array-item",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.progress",
        summary: "Thinking",
        tone: "info",
        payload: {
          data: {
            items: [
              {
                type: "tool_result",
                title: "Goal updated",
                result: {
                  goal: {
                    objective: "Implement provider feature parity",
                    status: "active",
                  },
                },
              },
            ],
          },
        },
      }),
      makeActivity({
        id: "goal-nested-tool-call",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "reasoning.completed",
        summary: "Thinking",
        tone: "info",
        payload: {
          data: {
            toolCall: {
              name: "update_goal",
              output: {
                objective: "Implement provider feature parity",
                status: "paused",
              },
            },
          },
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)).toEqual([]);
  });

  it("does not render streamed goal lifecycle text fields inside thinking payloads", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "goal-streamed-text-item",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.progress",
        summary: "Thinking",
        tone: "info",
        payload: {
          data: {
            item: {
              text: "Goal updated",
              output_text: "Implement provider feature parity",
              result: {
                status: "active",
                objective: "Implement provider feature parity",
              },
            },
          },
        },
      }),
      makeActivity({
        id: "goal-streamed-delta-item",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "reasoning.completed",
        summary: "Thinking",
        tone: "info",
        payload: {
          data: {
            items: [
              {
                label: "Goal updated",
                delta: "Implement provider feature parity",
                output: {
                  goal: {
                    status: "active",
                    objective: "Implement provider feature parity",
                  },
                },
              },
            ],
          },
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)).toEqual([]);
  });

  it("does not render status-prefixed goal lifecycle text inside thinking payloads", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "goal-prefixed-thinking-item",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.progress",
        summary: "Thinking",
        tone: "info",
        payload: {
          data: {
            item: {
              description: "✓ Goal updated",
              detail: "Implement provider feature parity",
              result: {
                status: "active",
                objective: "Implement provider feature parity",
              },
            },
          },
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)).toEqual([]);
  });

  it("does not render serialized goal lifecycle provider payloads", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "goal-serialized-function-call",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.progress",
        summary: "Thinking",
        tone: "info",
        payload: {
          data: {
            item: {
              type: "function_call_output",
              output:
                '{"toolName":"update_goal","title":"Goal updated","result":{"objective":"Implement provider feature parity","status":"active"}}',
            },
          },
        },
      }),
      makeActivity({
        id: "goal-nested-function-call",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "reasoning.completed",
        summary: "Thinking",
        tone: "info",
        payload: {
          data: {
            item: {
              function_call: {
                function: {
                  name: "update_goal",
                },
                arguments: {
                  objective: "Implement provider feature parity",
                  status: "paused",
                },
              },
            },
          },
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)).toEqual([]);
  });

  it("does not render provider-namespaced goal tool activity in thinking rows", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "goal-provider-tool-thinking",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "reasoning.completed",
        summary: "Thinking",
        tone: "info",
        payload: {
          data: {
            item: {
              type: "function_call_output",
              name: "functions.update_goal",
              output: {
                objective: "Implement provider feature parity",
                status: "active",
              },
            },
          },
        },
      }),
      makeActivity({
        id: "goal-provider-tool-progress",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Thinking",
        tone: "info",
        payload: {
          data: {
            item: {
              toolName: "tools.update_goal",
              text: "Goal updated\nImplement provider feature parity",
            },
          },
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)).toEqual([]);
    expect(deriveActiveGoalState(activities)).toEqual({
      createdAt: "2026-02-23T00:00:02.000Z",
      threadId: "active-thread",
      objective: "Implement provider feature parity",
      status: "active",
    });
  });

  it("does not render separator-namespaced provider goal lifecycle tools", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "goal-mcp-namespaced-tool",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "reasoning.completed",
        summary: "Thinking",
        tone: "info",
        payload: {
          data: {
            item: {
              type: "function_call_output",
              name: "mcp__goals__update_goal",
              output: {
                objective: "Keep provider goal state out of transcript",
                status: "active",
              },
            },
          },
        },
      }),
      makeActivity({
        id: "goal-thread-path-tool",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Thinking",
        tone: "info",
        payload: {
          data: {
            item: {
              toolName: "thread/goal/set",
              outputText: "Goal updated\nKeep provider goal state out of transcript",
              result: {
                objective: "Keep provider goal state out of transcript",
                status: "paused",
              },
            },
          },
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)).toEqual([]);
    expect(deriveActiveGoalState(activities)).toEqual({
      createdAt: "2026-02-23T00:00:02.000Z",
      threadId: "active-thread",
      objective: "Keep provider goal state out of transcript",
      status: "paused",
    });
  });

  it("does not render provider goal updates from generic completed items", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "goal-generic-provider-item",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "item.completed",
        summary: "Goal updated",
        tone: "info",
        payload: {
          data: {
            item: {
              type: "function_call_output",
              name: "update_goal",
              result: {
                goal: {
                  threadId: "provider-thread-1",
                  objective: "Implement provider feature parity",
                  status: "active",
                },
              },
            },
          },
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)).toEqual([]);
    expect(deriveActiveGoalState(activities)).toEqual({
      createdAt: "2026-02-23T00:00:01.000Z",
      threadId: "provider-thread-1",
      objective: "Implement provider feature parity",
      status: "active",
    });
  });

  it("derives goal panel state from plain streamed goal lifecycle text without rendering it", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "goal-plain-streamed-text",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.progress",
        summary: "Thinking",
        tone: "info",
        payload: {
          data: {
            item: {
              type: "function_call_output",
              outputText:
                "Goal updated\nImplement the latest provider features without transcript leaks",
            },
          },
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)).toEqual([]);
    expect(deriveActiveGoalState(activities)).toEqual({
      createdAt: "2026-02-23T00:00:01.000Z",
      threadId: "active-thread",
      objective: "Implement the latest provider features without transcript leaks",
      status: "active",
    });
  });

  it("does not render nested provider goal content arrays and still updates goal state", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "goal-provider-content-array",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "reasoning.completed",
        summary: "Thinking",
        tone: "info",
        payload: {
          data: {
            item: {
              type: "function_call_output",
              name: "functions.update_goal",
              content: [
                { type: "text", text: "Goal updated" },
                {
                  type: "text",
                  text: "Implement provider feature parity without transcript leaks",
                },
              ],
              output: [
                {
                  type: "text",
                  text: "Goal updated\nImplement provider feature parity without transcript leaks",
                },
              ],
            },
          },
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)).toEqual([]);
    expect(deriveActiveGoalState(activities)).toEqual({
      createdAt: "2026-02-23T00:00:01.000Z",
      threadId: "active-thread",
      objective: "Implement provider feature parity without transcript leaks",
      status: "active",
    });
  });

  it("clears goal panel state from plain streamed goal clear text", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "goal-active",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "goal.updated",
        summary: "Goal updated",
        tone: "info",
        payload: {
          threadId: "provider-thread-1",
          objective: "Implement provider feature parity",
          status: "active",
        },
      }),
      makeActivity({
        id: "goal-plain-clear-text",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Thinking",
        tone: "info",
        payload: {
          data: {
            item: {
              type: "function_call_output",
              outputText: "Goal cleared",
            },
          },
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)).toEqual([]);
    expect(deriveActiveGoalState(activities)).toBeNull();
  });

  it("omits tool started entries and keeps completed entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "tool-start",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Tool call",
        kind: "tool.started",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("surfaces runtime.error payload.message as work log detail", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "runtime-err-msg",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "runtime.error",
        summary: "Runtime error",
        tone: "error",
        payload: {
          message: "GitHub Copilot turn failed: network timeout",
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.label).toBe("Runtime error");
    expect(entry?.detail).toBe("GitHub Copilot turn failed: network timeout");
    expect(entry?.diagnosticKind).toBe("runtime-error");
  });

  it("combines runtime.warning message with structured detail for the work log", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "runtime-warn-detail",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "runtime.warning",
        summary: "Runtime warning",
        tone: "info",
        payload: {
          message: "Retry scheduled",
          detail: { code: 429, reason: "rate limit" },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.diagnosticKind).toBe("runtime-warning");
    expect(entry?.detail).toContain("Retry scheduled");
    expect(entry?.detail).toContain("429");
    expect(entry?.detail).toContain("rate limit");
  });

  it("omits task start and completion lifecycle entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        summary: "default task started",
        tone: "info",
      }),
      makeActivity({
        id: "task-progress",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Updating files",
        tone: "info",
      }),
      makeActivity({
        id: "task-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.completed",
        summary: "Task completed",
        tone: "info",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["task-progress"]);
  });

  it("filters by turn id when provided", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "turn-1", turnId: "turn-1", summary: "Tool call", kind: "tool.started" }),
      makeActivity({
        id: "turn-2",
        turnId: "turn-2",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({ id: "no-turn", summary: "Checkpoint captured", tone: "info" }),
    ];

    const entries = deriveWorkLogEntries(activities, TurnId.makeUnsafe("turn-2"));
    expect(entries.map((entry) => entry.id)).toEqual(["turn-2"]);
  });

  it("does not merge identical tool lifecycles from different turns", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "t1-start",
        turnId: "turn-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.started",
        summary: "Read file",
        payload: { itemType: "file_change", title: "Read file" },
      }),
      makeActivity({
        id: "t1-done",
        turnId: "turn-1",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Read file",
        payload: { itemType: "file_change", title: "Read file" },
      }),
      makeActivity({
        id: "t2-start",
        turnId: "turn-2",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.started",
        summary: "Read file",
        payload: { itemType: "file_change", title: "Read file" },
      }),
      makeActivity({
        id: "t2-done",
        turnId: "turn-2",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "tool.completed",
        summary: "Read file",
        payload: { itemType: "file_change", title: "Read file" },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.id)).toEqual(["t1-done", "t2-done"]);
  });

  it("derives Codex child conversation ids as subagent metadata", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "child-reasoning",
        turnId: "turn-child",
        kind: "reasoning.completed",
        summary: "Thought",
        payload: {
          itemType: "reasoning",
          detail: "Checking build and test health.",
          data: {
            ace: {
              parentTurnId: "turn-parent",
              childProviderThreadId: "child_provider_1",
            },
          },
        },
      }),
      makeActivity({
        id: "collab-call",
        turnId: "turn-parent",
        kind: "tool.completed",
        summary: "Subagent",
        payload: {
          itemType: "collab_agent_tool_call",
          title: "Subagent",
          data: {
            item: {
              type: "collabAgentToolCall",
              agentNickname: "Dewey",
              agentRole: "explorer",
              receiverThreadIds: ["child_provider_2"],
            },
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      subagentId: "child_provider_1",
      subagentType: "codex subagent",
    });
    expect(entries[1]).toMatchObject({
      itemType: "collab_agent_tool_call",
      subagentId: "child_provider_2",
      subagentName: "Dewey",
      subagentType: "explorer",
    });
  });

  it("derives provider-agnostic root subagent metadata", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "root-subagent-response",
        turnId: "turn-root-subagent",
        kind: "task.progress",
        summary: "Subagent message",
        payload: {
          itemType: "assistant_message",
          detail: "Root subagent result.",
          subagent: {
            id: "agent-root-1",
            parentId: "agent-parent-1",
            type: "code-reviewer",
            name: "Reviewer",
            model: "claude-sonnet",
          },
        },
      }),
      makeActivity({
        id: "root-child-provider-response",
        turnId: "turn-root-child-provider",
        kind: "task.progress",
        summary: "Subagent message",
        payload: {
          itemType: "assistant_message",
          detail: "Root child provider result.",
          childProviderThreadId: "child-provider-root-1",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toHaveLength(2);
    const rootSubagentEntry = entries.find((entry) => entry.subagentId === "agent-root-1");
    const rootChildProviderEntry = entries.find(
      (entry) => entry.subagentId === "child-provider-root-1",
    );
    expect(rootSubagentEntry).toMatchObject({
      subagentId: "agent-root-1",
      subagentParentId: "agent-parent-1",
      subagentType: "code-reviewer",
      subagentName: "Reviewer",
      subagentModel: "claude-sonnet",
      sideChatMessageRole: "assistant",
      sideChatMessageText: "Root subagent result.",
    });
    expect(rootChildProviderEntry).toMatchObject({
      subagentId: "child-provider-root-1",
      subagentType: "codex subagent",
      sideChatMessageRole: "assistant",
      sideChatMessageText: "Root child provider result.",
    });
  });

  it("prefers provider child session ids over agent ids for separate side chats", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "provider-side-chat-a",
          turnId: "turn-provider-side-chat-a",
          kind: "task.progress",
          summary: "Subagent message",
          payload: {
            itemType: "assistant_message",
            detail: "First reviewer side-chat response.",
            data: {
              sessionId: "provider-child-session-a",
              subagent: {
                id: "reviewer",
                type: "provider subagent",
                name: "Reviewer",
              },
            },
          },
        }),
        makeActivity({
          id: "provider-side-chat-b",
          turnId: "turn-provider-side-chat-b",
          kind: "task.progress",
          summary: "Subagent message",
          payload: {
            itemType: "assistant_message",
            detail: "Second reviewer side-chat response.",
            data: {
              sessionID: "provider-child-session-b",
              subagent: {
                id: "reviewer",
                type: "provider subagent",
                name: "Reviewer",
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.subagentId)).toEqual([
      "provider-child-session-a",
      "provider-child-session-b",
    ]);
    expect(entries.map((entry) => entry.subagentName)).toEqual(["Reviewer", "Reviewer"]);
  });

  it("derives multiple side-chat entries from one provider side-chat array payload", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "provider-side-chat-array-response",
          turnId: "turn-provider-side-chat-array",
          kind: "task.progress",
          summary: "Side chat responses",
          payload: {
            itemType: "assistant_message",
            detail: "Provider reported multiple side chats.",
            data: {
              sideChats: [
                {
                  threadId: "provider-side-chat-a",
                  displayName: "Reviewer A",
                  role: "side-chat",
                  response: "Reviewer A result.",
                },
                {
                  threadId: "provider-side-chat-b",
                  displayName: "Reviewer B",
                  role: "side-chat",
                  response: "Reviewer B result.",
                },
              ],
            },
          },
        }),
      ],
      undefined,
    );

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.subagentId)).toEqual([
      "provider-side-chat-a",
      "provider-side-chat-b",
    ]);
    expect(entries.map((entry) => entry.subagentName)).toEqual(["Reviewer A", "Reviewer B"]);
    expect(entries.map((entry) => entry.sideChatMessageRole)).toEqual(["assistant", "assistant"]);
    expect(entries[1]).toMatchObject({
      detail: "Reviewer B result.",
      sideChatMessageText: "Reviewer B result.",
    });
  });

  it("derives multiple provider fleet subagent entries from one agent array payload", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "provider-fleet-agent-array-response",
          turnId: "turn-provider-fleet-agent-array",
          kind: "task.progress",
          summary: "Fleet responses",
          payload: {
            itemType: "assistant_message",
            detail: "Provider reported multiple fleet agents.",
            data: {
              agents: [
                {
                  id: "copilot-fleet-agent-a",
                  displayName: "Explore",
                  role: "subagent",
                  response: "Explore result.",
                },
                {
                  id: "copilot-fleet-agent-b",
                  displayName: "Task",
                  role: "subagent",
                  response: "Task result.",
                },
              ],
            },
          },
        }),
      ],
      undefined,
    );

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.subagentId)).toEqual([
      "copilot-fleet-agent-a",
      "copilot-fleet-agent-b",
    ]);
    expect(entries.map((entry) => entry.subagentName)).toEqual(["Explore", "Task"]);
    expect(entries.map((entry) => entry.sideChatMessageRole)).toEqual(["assistant", "assistant"]);
    expect(entries[1]).toMatchObject({
      detail: "Task result.",
      sideChatMessageText: "Task result.",
    });
  });

  it("derives multiple provider child entries from generic child collections", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "provider-generic-children-response",
          turnId: "turn-provider-generic-children",
          kind: "task.progress",
          summary: "Generic child responses",
          payload: {
            itemType: "assistant_message",
            detail: "Provider reported generic children.",
            data: {
              children: [
                {
                  childProviderThreadId: "provider-child-thread-a",
                  agentName: "Reviewer",
                  agentRole: "subagent",
                  response: "Reviewer result.",
                },
                {
                  resource: {
                    attributes: {
                      "gen_ai.agent.id": "provider-child-thread-b",
                      "gen_ai.agent.name": "Planner",
                      "gen_ai.agent.role": "subagent",
                    },
                  },
                  response: "Planner result.",
                },
                {
                  type: "text",
                  text: "Plain provider output.",
                },
              ],
            },
          },
        }),
      ],
      undefined,
    );

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.subagentId)).toEqual([
      "provider-child-thread-a",
      "provider-child-thread-b",
    ]);
    expect(entries.map((entry) => entry.subagentName)).toEqual(["Reviewer", "Planner"]);
    expect(entries.map((entry) => entry.sideChatMessageText)).toEqual([
      "Reviewer result.",
      "Planner result.",
    ]);
  });

  it("derives a provider child entry from a single generic child collection record", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "provider-generic-single-child-response",
          turnId: "turn-provider-generic-single-child",
          kind: "task.progress",
          summary: "Generic child response",
          payload: {
            itemType: "assistant_message",
            detail: "Provider reported a generic child.",
            data: {
              children: [
                {
                  childProviderThreadId: "provider-child-thread-a",
                  agentName: "Reviewer",
                  agentRole: "subagent",
                  response: "Reviewer result.",
                },
              ],
            },
          },
        }),
      ],
      undefined,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.subagentId).toBe("provider-child-thread-a");
    expect(entries[0]?.subagentName).toBe("Reviewer");
    expect(entries[0]?.sideChatMessageText).toBe("Reviewer result.");
  });

  it("derives provider subagent metadata from telemetry attributes", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "provider-telemetry-subagent-response",
          turnId: "turn-provider-telemetry-subagent",
          kind: "task.progress",
          summary: "Telemetry subagent response",
          payload: {
            itemType: "assistant_message",
            detail: "Telemetry agent result.",
            attributes: {
              "gen_ai.agent.id": "github.copilot.default.explore",
              "gen_ai.agent.name": "Explore",
              "gen_ai.agent.role": "subagent",
              "gen_ai.request.model": "gpt-5-copilot",
            },
          },
        }),
      ],
      undefined,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      subagentId: "github.copilot.default.explore",
      subagentType: "subagent",
      subagentName: "Explore",
      subagentModel: "gpt-5-copilot",
      sideChatMessageRole: "assistant",
      sideChatMessageText: "Telemetry agent result.",
    });
  });

  it("derives provider side-chat ids from side conversation aliases", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "provider-side-conversation-user",
          turnId: "turn-provider-side-conversation",
          kind: "subagent.message.sent",
          summary: "Side chat message",
          payload: {
            detail: "Review this without polluting the parent context.",
            sideConversation: {
              id: "provider-side-conversation-1",
              parentThreadId: "thread-parent-1",
              type: "side chat",
            },
            subagentType: "side chat",
            subagentName: "Context helper",
          },
        }),
        makeActivity({
          id: "provider-side-conversation-assistant",
          turnId: "turn-provider-side-conversation",
          kind: "task.progress",
          summary: "Side chat response",
          payload: {
            itemType: "assistant_message",
            detail: "The parent context stays clean.",
            data: {
              provider_side_conversation_id: "provider-side-conversation-1",
              subagent_type: "side chat",
              subagent_name: "Context helper",
            },
          },
        }),
      ],
      undefined,
    );

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.subagentId)).toEqual([
      "provider-side-conversation-1",
      "provider-side-conversation-1",
    ]);
    expect(entries.find((entry) => entry.sideChatMessageRole === "user")?.subagentParentId).toBe(
      "thread-parent-1",
    );
    expect(entries.map((entry) => entry.sideChatMessageRole).toSorted()).toEqual([
      "assistant",
      "user",
    ]);
  });

  it("derives provider-agnostic root scalar agent metadata", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "root-agent-scalar-response",
          turnId: "turn-root-agent-scalar",
          kind: "task.progress",
          summary: "Subagent message",
          payload: {
            itemType: "assistant_message",
            detail: "Root scalar agent result.",
            agentId: "agent-scalar-1",
            agentName: "Scalar Reviewer",
            agentRole: "code-reviewer",
            model: "gpt-5.4",
          },
        }),
      ],
      undefined,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      subagentId: "agent-scalar-1",
      subagentType: "code-reviewer",
      subagentName: "Scalar Reviewer",
      subagentModel: "gpt-5.4",
      sideChatMessageRole: "assistant",
      sideChatMessageText: "Root scalar agent result.",
    });
  });

  it("derives provider-agnostic root display-name subagent aliases", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "root-display-subagent-response",
          turnId: "turn-root-display-subagent",
          kind: "task.progress",
          summary: "Subagent message",
          payload: {
            itemType: "assistant_message",
            detail: "Root display subagent result.",
            subagentId: "subagent-display-1",
            agentDisplayName: "Display Reviewer",
            agentRole: "code-reviewer",
            model: "gpt-5.4",
          },
        }),
      ],
      undefined,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      subagentId: "subagent-display-1",
      subagentType: "code-reviewer",
      subagentName: "Display Reviewer",
      subagentModel: "gpt-5.4",
      sideChatMessageRole: "assistant",
      sideChatMessageText: "Root display subagent result.",
    });
  });

  it("derives provider-agnostic nested agent metadata", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "root-nested-agent-response",
          turnId: "turn-root-nested-agent",
          kind: "task.progress",
          summary: "Subagent message",
          payload: {
            itemType: "assistant_message",
            detail: "Root nested agent result.",
            data: {
              agent: {
                id: "nested-agent-1",
                name: "Nested Reviewer",
                role: "code-reviewer",
                model: "gpt-5.4",
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      subagentId: "nested-agent-1",
      subagentType: "code-reviewer",
      subagentName: "Nested Reviewer",
      subagentModel: "gpt-5.4",
      sideChatMessageRole: "assistant",
      sideChatMessageText: "Root nested agent result.",
    });
  });

  it("derives provider-agnostic item-nested agent metadata", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "root-item-agent-response",
          turnId: "turn-root-item-agent",
          kind: "task.progress",
          summary: "Subagent message",
          payload: {
            itemType: "assistant_message",
            detail: "Root item agent result.",
            data: {
              item: {
                agent: {
                  id: "item-agent-1",
                  name: "Item Reviewer",
                  role: "researcher",
                  model: "gpt-5.4",
                },
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      subagentId: "item-agent-1",
      subagentType: "researcher",
      subagentName: "Item Reviewer",
      subagentModel: "gpt-5.4",
      sideChatMessageRole: "assistant",
      sideChatMessageText: "Root item agent result.",
    });
  });

  it("derives provider-agnostic delegated agent metadata", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "root-delegated-agent-response",
          turnId: "turn-root-delegated-agent",
          kind: "task.progress",
          summary: "Subagent message",
          payload: {
            itemType: "assistant_message",
            detail: "Delegated agent result.",
            data: {
              assignedAgent: {
                id: "assigned-agent-1",
                displayName: "Platform Specialist",
                role: "platform",
                model: "gpt-5.4",
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      subagentId: "assigned-agent-1",
      subagentType: "platform",
      subagentName: "Platform Specialist",
      subagentModel: "gpt-5.4",
      sideChatMessageRole: "assistant",
      sideChatMessageText: "Delegated agent result.",
    });
  });

  it("derives provider-agnostic root subagent metadata from collab tool calls", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "root-collab-tool",
          turnId: "turn-root-collab-tool",
          kind: "tool.started",
          summary: "Reviewer",
          payload: {
            itemType: "collab_agent_tool_call",
            title: "Reviewer",
            detail: "Review this change.",
            subagent: {
              id: "agent-root-tool-1",
              type: "code-reviewer",
              name: "Reviewer",
              model: "claude-sonnet",
            },
          },
        }),
      ],
      undefined,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      itemType: "collab_agent_tool_call",
      subagentId: "agent-root-tool-1",
      subagentType: "code-reviewer",
      subagentName: "Reviewer",
      subagentModel: "claude-sonnet",
      sideChatMessageId: "root-collab-tool",
      sideChatMessageRole: "user",
      sideChatMessageText: "Review this change.",
    });
  });

  it("uses provider prompt aliases as the side-chat opening message", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "root-collab-tool-instructions",
          turnId: "turn-root-collab-tool-instructions",
          kind: "tool.started",
          summary: "Reviewer",
          payload: {
            itemType: "collab_agent_tool_call",
            title: "Reviewer",
            data: {
              subagent: {
                id: "agent-root-tool-instructions-1",
                type: "code-reviewer",
                name: "Reviewer",
              },
              input: {
                instructions: "Review this change without adding to the main thread.",
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      itemType: "collab_agent_tool_call",
      subagentId: "agent-root-tool-instructions-1",
      subagentType: "code-reviewer",
      subagentName: "Reviewer",
      sideChatMessageId: "root-collab-tool-instructions",
      sideChatMessageRole: "user",
      sideChatMessageText: "Review this change without adding to the main thread.",
    });
  });

  it("uses provider args aliases as the side-chat opening message", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "root-collab-tool-args",
          turnId: "turn-root-collab-tool-args",
          kind: "tool.started",
          summary: "Researcher",
          payload: {
            itemType: "collab_agent_tool_call",
            title: "Researcher",
            data: {
              subagent: {
                id: "agent-root-tool-args-1",
                type: "researcher",
                name: "Researcher",
              },
              args: {
                message: "Inspect the provider docs in a side conversation.",
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      itemType: "collab_agent_tool_call",
      subagentId: "agent-root-tool-args-1",
      subagentType: "researcher",
      subagentName: "Researcher",
      sideChatMessageId: "root-collab-tool-args",
      sideChatMessageRole: "user",
      sideChatMessageText: "Inspect the provider docs in a side conversation.",
    });
  });

  it("marks Codex side-chat activity as timeline messages", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "side-user-activity",
        kind: "subagent.message.sent",
        summary: "User message",
        payload: {
          detail: "Please keep checking the build.",
          messageId: "side-user-message",
          subagent: {
            id: "child_provider_1",
            type: "codex subagent",
          },
        },
      }),
      makeActivity({
        id: "side-assistant-activity",
        kind: "task.progress",
        summary: "Subagent message",
        payload: {
          itemType: "assistant_message",
          detail: "I am checking the build now.",
          data: {
            ace: {
              childProviderThreadId: "child_provider_1",
            },
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    const userMessage = entries.find((entry) => entry.sideChatMessageRole === "user");
    const assistantMessage = entries.find((entry) => entry.sideChatMessageRole === "assistant");

    expect(entries).toHaveLength(2);
    expect(userMessage).toMatchObject({
      sideChatMessageId: "side-user-message",
      sideChatMessageRole: "user",
      sideChatMessageText: "Please keep checking the build.",
      subagentId: "child_provider_1",
    });
    expect(assistantMessage).toMatchObject({
      sideChatMessageId: "side-assistant-activity",
      sideChatMessageRole: "assistant",
      sideChatMessageText: "I am checking the build now.",
      subagentId: "child_provider_1",
    });
  });

  it("marks provider subagent lifecycle final messages as side-chat assistant entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "claude-subagent-stop",
        kind: "tool.completed",
        summary: "Subagent task",
        tone: "tool",
        payload: {
          itemType: "collab_agent_tool_call",
          data: {
            subagent: {
              id: "agent-hook-1",
              type: "Explore",
              transcriptPath: "/repo/.claude/projects/session/subagents/agent-hook-1.jsonl",
              lastAssistantMessage: "Found two relevant files.",
            },
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      sideChatMessageId: "claude-subagent-stop:assistant",
      sideChatMessageRole: "assistant",
      sideChatMessageText: "Found two relevant files.",
      subagentId: "agent-hook-1",
      subagentType: "Explore",
      subagentTranscriptPath: "/repo/.claude/projects/session/subagents/agent-hook-1.jsonl",
    });
  });

  it("marks provider subagent content-part final messages as side-chat assistant entries", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        id: "provider-subagent-content-stop",
        kind: "tool.completed",
        summary: "Subagent task",
        tone: "tool",
        payload: {
          itemType: "collab_agent_tool_call",
          data: {
            subagent: {
              id: "agent-content-1",
              type: "Explore",
              finalAssistantMessage: {
                content: [
                  { type: "text", text: "Found the adapter." },
                  { type: "text", text: "The event path is covered." },
                ],
              },
            },
          },
        },
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      sideChatMessageId: "provider-subagent-content-stop:assistant",
      sideChatMessageRole: "assistant",
      sideChatMessageText: "Found the adapter.\nThe event path is covered.",
      subagentId: "agent-content-1",
      subagentType: "Explore",
    });
  });

  it("marks provider subagent transcript arrays as side-chat assistant entries", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        id: "provider-subagent-transcript-stop",
        kind: "tool.completed",
        summary: "Subagent task",
        tone: "tool",
        payload: {
          itemType: "collab_agent_tool_call",
          data: {
            subagent: {
              id: "agent-transcript-1",
              type: "Research",
              messages: [
                { role: "user", text: "Inspect the provider adapters." },
                { role: "assistant", text: "The first adapter is covered." },
                { role: "user", text: "Check the side-chat path too." },
                { role: "assistant", text: "The side-chat path is covered." },
              ],
            },
          },
        },
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      sideChatMessageId: "provider-subagent-transcript-stop:assistant",
      sideChatMessageRole: "assistant",
      sideChatMessageText: "The side-chat path is covered.",
      subagentId: "agent-transcript-1",
      subagentType: "Research",
    });
  });

  it("omits checkpoint captured info entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "checkpoint",
        createdAt: "2026-02-23T00:00:01.000Z",
        summary: "Checkpoint captured",
        tone: "info",
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Ran command",
        tone: "tool",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("omits generated turn summary info entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "turn-summary",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "workspace.summary.generated",
        summary: "Updated editor summary panel",
        tone: "info",
        payload: {
          headline: "Updated editor summary panel",
          summary: "Added AI-generated summaries to the side panel.",
          keyChanges: ["Rendered summary card"],
          risks: [],
        },
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Ran command",
        tone: "tool",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("omits ExitPlanMode lifecycle entries once the plan card is shown", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "exit-plan-updated",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          detail: 'ExitPlanMode: {"allowedPrompts":[{"tool":"Bash","prompt":"run tests"}]}',
        },
      }),
      makeActivity({
        id: "exit-plan-completed",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          detail: "ExitPlanMode: {}",
        },
      }),
      makeActivity({
        id: "real-work-log",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          detail: "Bash: bun test",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["real-work-log"]);
  });

  it("orders work log by activity sequence when present", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "second",
        createdAt: "2026-02-23T00:00:03.000Z",
        sequence: 2,
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "first",
        createdAt: "2026-02-23T00:00:04.000Z",
        sequence: 1,
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["first", "second"]);
  });

  it("extracts command text for command tool activities", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: ["bun", "run", "lint"],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.command).toBe("bun run lint");
  });

  it("keeps compact Codex tool metadata used for icons and labels", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-with-metadata",
        kind: "tool.completed",
        summary: "bash",
        payload: {
          itemType: "command_execution",
          title: "bash",
          status: "completed",
          detail: '{ "dev": "vite dev --port 3000" } <exited with exit code 0>',
          data: {
            item: {
              command: ["bun", "run", "dev"],
              result: {
                content: '{ "dev": "vite dev --port 3000" } <exited with exit code 0>',
                exitCode: 0,
              },
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry).toMatchObject({
      command: "bun run dev",
      detail: '{ "dev": "vite dev --port 3000" }',
      itemType: "command_execution",
      toolTitle: "Run command",
    });
  });

  it("maps reasoning-style activities to thinking tone", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "reasoning-progress",
        kind: "task.progress",
        summary: "Reasoning update",
        tone: "info",
        payload: {
          detail: "Inspecting project structure",
        },
      }),
      makeActivity({
        id: "reasoning-complete",
        kind: "reasoning.completed",
        summary: "Reasoning",
        tone: "info",
        payload: {
          itemType: "reasoning",
          detail: "Ready to patch the adapter",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.tone).toBe("thinking");
    expect(entries[1]?.tone).toBe("thinking");
  });

  it("collapses streamed reasoning updates for the same reasoning task", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "reasoning-progress-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.progress",
        summary: "Reasoning",
        tone: "info",
        payload: {
          taskId: "reasoning:item-1",
          detail: "Inspecting package scripts.",
        },
      }),
      makeActivity({
        id: "reasoning-progress-2",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Reasoning",
        tone: "info",
        payload: {
          taskId: "reasoning:item-1",
          detail: "Running format and lint checks.",
        },
      }),
      makeActivity({
        id: "reasoning-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "reasoning.completed",
        summary: "Reasoning",
        tone: "info",
        payload: {
          taskId: "reasoning:item-1",
          itemType: "reasoning",
          detail: "Checks finished; ready to patch the timeline.",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      createdAt: "2026-02-23T00:00:01.000Z",
      tone: "thinking",
      detail:
        "Inspecting package scripts. Running format and lint checks. Checks finished; ready to patch the timeline.",
    });
  });

  it("keeps empty terminal reasoning completion entries instead of dropping them", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "reasoning-complete-empty",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "reasoning.completed",
        summary: "Reasoning",
        tone: "info",
        payload: {
          taskId: "reasoning:item-empty-complete",
          itemType: "reasoning",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      createdAt: "2026-02-23T00:00:03.000Z",
      tone: "thinking",
      label: "Reasoning",
    });
    expect(entries[0]?.detail).toBeUndefined();
  });

  it("accumulates token-like streamed reasoning fragments into readable text", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "reasoning-token-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.progress",
        summary: "Reasoning",
        tone: "info",
        payload: {
          taskId: "reasoning:item-tokenized",
          detail: "Inspecting",
        },
      }),
      makeActivity({
        id: "reasoning-token-2",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Reasoning",
        tone: "info",
        payload: {
          taskId: "reasoning:item-tokenized",
          detail: "package.json",
        },
      }),
      makeActivity({
        id: "reasoning-token-3",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.progress",
        summary: "Reasoning",
        tone: "info",
        payload: {
          taskId: "reasoning:item-tokenized",
          detail: "before patching.",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.detail).toBe("Inspecting package.json before patching.");
  });

  it("keeps tool starts visible and collapses them into the final tool entry", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-started",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.started",
        summary: "Running format & checks",
        tone: "tool",
        payload: {
          itemType: "command_execution",
          title: "Running format & checks",
          detail: "Running format & checks",
        },
      }),
      makeActivity({
        id: "tool-completed",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Running format & checks",
        tone: "tool",
        payload: {
          itemType: "command_execution",
          title: "Running format & checks",
          detail: "Formatting and checks completed successfully.",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      createdAt: "2026-02-23T00:00:01.000Z",
      toolTitle: "Running format & checks",
      detail: "Formatting and checks completed successfully.",
    });
  });

  it("extracts embedded intent text from tool metadata carried on the same work entry", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-intent-combined",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.completed",
        summary: "Running format & checks",
        tone: "tool",
        payload: {
          itemType: "command_execution",
          title: "Running format & checks",
          detail: "Formatting and checks completed successfully.",
          data: {
            toolName: "run_in_terminal",
            toolTitle:
              'Report Intent - {"intent":"Running format & checks"} Running format & checks',
            arguments: {
              intent: "Running format & checks",
              command: "bun fmt && bun lint && bun typecheck",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry).toMatchObject({
      toolTitle: "Running format & checks",
      detail: "Formatting and checks completed successfully.",
      intentText: "Running format & checks",
    });
  });

  it("extracts changed file paths for file-change tool activities", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-tool",
        kind: "tool.completed",
        summary: "File change",
        payload: {
          itemType: "file_change",
          data: {
            item: {
              changes: [
                { path: "apps/web/src/components/ChatView.tsx" },
                { filename: "apps/web/src/session-logic.ts" },
              ],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.changedFiles).toEqual([
      "apps/web/src/components/ChatView.tsx",
      "apps/web/src/session-logic.ts",
    ]);
  });

  it("does not treat read-only file tool payloads as file changes", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "read-title",
        kind: "tool.completed",
        summary: "Read file",
        payload: {
          itemType: "file_change",
          title: "Read file",
          data: {
            toolCallId: "read-title",
            path: "README.md",
          },
        },
      }),
      makeActivity({
        id: "read-detail",
        kind: "tool.completed",
        summary: "File change",
        payload: {
          itemType: "file_change",
          title: "File change",
          detail: "Read File",
          data: {
            toolCallId: "read-detail",
            path: "apps/web/src/session-logic.ts",
          },
        },
      }),
      makeActivity({
        id: "search-title",
        kind: "tool.completed",
        summary: "Find",
        payload: {
          itemType: "file_change",
          title: "Find",
          data: {
            toolCallId: "search-title",
            path: "apps/web/src",
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    const readTitle = entries.find((entry) => entry.id === "read-title");
    const readDetail = entries.find((entry) => entry.id === "read-detail");
    const searchTitle = entries.find((entry) => entry.id === "search-title");

    expect(readTitle).toMatchObject({
      toolTitle: "Read file",
      requestKind: "file-read",
      detail: "README.md",
    });
    expect(readTitle?.changedFiles).toBeUndefined();
    expect(readDetail).toMatchObject({
      toolTitle: "Read file",
      requestKind: "file-read",
      detail: "Read File",
    });
    expect(readDetail?.changedFiles).toBeUndefined();
    expect(searchTitle).toMatchObject({
      toolTitle: "Search",
      detail: "apps/web/src",
    });
    expect(searchTitle?.requestKind).toBeUndefined();
    expect(searchTitle?.changedFiles).toBeUndefined();
  });

  it("derives readable Gemini tool labels from kind, locations, and path-like titles", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "gemini-read",
        kind: "tool.completed",
        summary: "README.md",
        payload: {
          itemType: "dynamic_tool_call",
          title: "README.md",
          data: {
            toolCallId: "tool-read",
            kind: "read",
            locations: [{ path: "README.md" }],
          },
        },
      }),
      makeActivity({
        id: "gemini-search",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          data: {
            toolCallId: "tool-search",
            kind: "search",
            rawInput: { pattern: "class Agent", path: "src" },
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      toolTitle: "Read file",
      detail: "README.md",
    });
    expect(entries[1]).toMatchObject({
      toolTitle: "Search",
      detail: "class Agent +1 more",
    });
  });

  it("normalizes provider JSON tool details into readable subjects", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "json-detail",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);

    expect(entry).toMatchObject({
      detail: "/tmp/app.ts",
    });
  });

  it("normalizes rough provider read and command payloads into Codex-style metadata", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "rough-read",
        kind: "tool.completed",
        summary: "Read",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read",
          detail:
            "<path>/Users/me/project/AGENTS.md</path>\n<type>file</type>\n<content>\n# AGENTS.md\n</content>",
          data: {
            toolName: "Read",
          },
        },
      }),
      makeActivity({
        id: "rough-command",
        kind: "tool.completed",
        summary: "Bash",
        payload: {
          itemType: "command_execution",
          title: "Bash",
          status: "failed",
          command: "bun run check",
          terminalOutput: "Format issues found in 1 file.\n",
          exitCode: 1,
          durationMs: 191,
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    const readEntry = entries.find((entry) => entry.id === "rough-read");
    const commandEntry = entries.find((entry) => entry.id === "rough-command");

    expect(readEntry).toMatchObject({
      toolTitle: "Read file",
      requestKind: "file-read",
      detail: "/Users/me/project/AGENTS.md",
    });
    expect(commandEntry).toMatchObject({
      toolTitle: "Run command",
      requestKind: "command",
      command: "bun run check",
      terminalOutput: "Format issues found in 1 file.\n",
      status: "failed",
      exitCode: 1,
      durationMs: 191,
    });
  });

  it("uses provider tool names and input data for generic Claude-style tool calls", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "claude-tool",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          data: {
            toolName: "grep_search",
            input: {
              query: "ProviderRuntimeEvent",
              path: "apps/server/src",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);

    expect(entry).toMatchObject({
      toolTitle: "Search",
      detail: "ProviderRuntimeEvent +1 more",
    });
  });

  it("collapses repeated lifecycle updates for the same tool call into one entry", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-update-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-update-2",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
          data: {
            item: {
              command: ["sed", "-n", "1,40p", "/tmp/app.ts"],
            },
          },
        },
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "tool-complete",
      createdAt: "2026-02-23T00:00:01.000Z",
      label: "Tool call completed",
      detail: "/tmp/app.ts",
      command: "sed -n 1,40p /tmp/app.ts",
      itemType: "dynamic_tool_call",
      toolTitle: "Tool call",
    });
  });

  it("collapses interleaved Cursor tool lifecycle rows by toolCallId", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-a-start",
        turnId: "turn-cursor",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.started",
        summary: "Read File",
        payload: {
          itemType: "file_change",
          title: "Read File",
          data: {
            item: { toolCallId: "tool-a" },
          },
        },
      }),
      makeActivity({
        id: "tool-a-update",
        turnId: "turn-cursor",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Read File",
        payload: {
          itemType: "file_change",
          title: "Read File",
          data: {
            item: { toolCallId: "tool-a" },
          },
        },
      }),
      makeActivity({
        id: "tool-b-start",
        turnId: "turn-cursor",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.started",
        summary: "Read File",
        payload: {
          itemType: "file_change",
          title: "Read File",
          data: {
            item: { toolCallId: "tool-b" },
          },
        },
      }),
      makeActivity({
        id: "tool-b-update",
        turnId: "turn-cursor",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "tool.updated",
        summary: "Read File",
        payload: {
          itemType: "file_change",
          title: "Read File",
          data: {
            item: { toolCallId: "tool-b" },
          },
        },
      }),
      makeActivity({
        id: "tool-a-complete",
        turnId: "turn-cursor",
        createdAt: "2026-02-23T00:00:05.000Z",
        kind: "tool.completed",
        summary: "Read File",
        payload: {
          itemType: "file_change",
          title: "Read File",
          detail: "README.md",
          data: {
            item: { toolCallId: "tool-a" },
          },
        },
      }),
      makeActivity({
        id: "tool-b-complete",
        turnId: "turn-cursor",
        createdAt: "2026-02-23T00:00:06.000Z",
        kind: "tool.completed",
        summary: "Read File",
        payload: {
          itemType: "file_change",
          title: "Read File",
          detail: "package.json",
          data: {
            item: { toolCallId: "tool-b" },
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries.map((entry) => entry.id)).toEqual(["tool-a-complete", "tool-b-complete"]);
    expect(entries.map((entry) => entry.createdAt)).toEqual([
      "2026-02-23T00:00:01.000Z",
      "2026-02-23T00:00:03.000Z",
    ]);
    expect(entries.map((entry) => entry.detail)).toEqual(["README.md", "package.json"]);
  });

  it("collapses normalized command output deltas into the command row", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-start",
        turnId: "turn-command-output",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.started",
        summary: "Ran command ls -la",
        payload: {
          itemType: "command_execution",
          itemId: "cmd-1",
          title: "Ran command ls -la",
          command: "ls -la",
        },
      }),
      makeActivity({
        id: "command-output-1",
        turnId: "turn-command-output",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Command output",
        payload: {
          itemType: "command_execution",
          itemId: "cmd-1",
          terminalOutput: "total 8\n",
        },
      }),
      makeActivity({
        id: "command-output-2",
        turnId: "turn-command-output",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.updated",
        summary: "Command output",
        payload: {
          itemType: "command_execution",
          itemId: "cmd-1",
          terminalOutput: "drwxr-xr-x .\n",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      label: "Ran command ls -la",
      toolTitle: "Ran command ls -la",
      command: "ls -la",
      terminalOutput: "total 8\ndrwxr-xr-x .\n",
      requestKind: "command",
    });
  });

  it("caps collapsed command output so large live logs do not dominate rendering", () => {
    const largeChunk = "x".repeat(20_000);
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-start",
        turnId: "turn-command-output",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.started",
        summary: "Ran command build",
        payload: {
          itemType: "command_execution",
          itemId: "cmd-1",
          title: "Ran command build",
          command: "build",
        },
      }),
      makeActivity({
        id: "command-output-1",
        turnId: "turn-command-output",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Command output",
        payload: {
          itemType: "command_execution",
          itemId: "cmd-1",
          terminalOutput: largeChunk,
        },
      }),
      makeActivity({
        id: "command-output-2",
        turnId: "turn-command-output",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.updated",
        summary: "Command output",
        payload: {
          itemType: "command_execution",
          itemId: "cmd-1",
          terminalOutput: "after-cap",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.terminalOutput).toHaveLength(16_000);
    expect(entries[0]?.terminalOutput?.endsWith("...")).toBe(true);
    expect(entries[0]?.terminalOutputTruncated).toBe(true);
  });

  it("keeps separate tool entries when an identical call starts after the prior one completed", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-1-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-1-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-2-update",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-2-complete",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries.map((entry) => entry.id)).toEqual(["tool-1-complete", "tool-2-complete"]);
  });

  it("collapses same-timestamp lifecycle rows even when completed sorts before updated by id", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "z-update-earlier",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "a-complete-same-timestamp",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "z-update-same-timestamp",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("a-complete-same-timestamp");
  });
});

describe("deriveTimelineEntries", () => {
  it("keeps provider goal lifecycle output out of the main worklog", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "goal-tool-output",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        tone: "tool",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          data: {
            item: {
              type: "function_call_output",
              name: "functions.update_goal",
              content: [
                { type: "text", text: "Goal updated" },
                { type: "text", text: "Keep goal state out of the transcript" },
              ],
              output: {
                status: "active",
                objective: "Keep goal state out of the transcript",
              },
            },
          },
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)).toEqual([]);
    expect(deriveActiveGoalState(activities)).toMatchObject({
      objective: "Keep goal state out of the transcript",
      status: "active",
    });
  });

  it("filters subagent work entries from the main thread timeline source", () => {
    const entries = filterMainTimelineWorkLogEntries([
      {
        id: "main-work",
        createdAt: "2026-02-23T00:00:01.000Z",
        label: "Ran command",
        tone: "tool",
      },
      {
        id: "subagent-reasoning",
        createdAt: "2026-02-23T00:00:02.000Z",
        label: "Thought",
        tone: "thinking",
        subagentId: "child-provider-thread-1",
        subagentName: "Dewey",
      },
      {
        id: "subagent-message",
        createdAt: "2026-02-23T00:00:03.000Z",
        label: "Subagent message",
        tone: "thinking",
        sideChatMessageRole: "assistant",
        sideChatMessageText: "I checked the project layout.",
      },
      {
        id: "collab-call",
        createdAt: "2026-02-23T00:00:04.000Z",
        label: "Subagent",
        tone: "tool",
        itemType: "collab_agent_tool_call",
      },
    ]);

    expect(entries.map((entry) => entry.id)).toEqual(["main-work"]);
  });

  it("filters native /side and hidden provider side-chat alias messages from the main thread timeline source", () => {
    const entries = filterMainTimelineMessages([
      {
        id: MessageId.makeUnsafe("main-message"),
        role: "user",
        text: "normal prompt",
        createdAt: "2026-02-23T00:00:01.000Z",
        streaming: false,
      },
      {
        id: MessageId.makeUnsafe("side-message"),
        role: "user",
        text: "/side inspect the server package",
        createdAt: "2026-02-23T00:00:02.000Z",
        streaming: false,
      },
      {
        id: MessageId.makeUnsafe("codex-side-message"),
        role: "user",
        text: ".side inspect the Codex app server",
        createdAt: "2026-02-23T00:00:03.000Z",
        streaming: false,
      },
      {
        id: MessageId.makeUnsafe("claude-side-message"),
        role: "user",
        text: "/btw inspect the Claude side context",
        createdAt: "2026-02-23T00:00:04.000Z",
        streaming: false,
      },
      {
        id: MessageId.makeUnsafe("normal-btw-message"),
        role: "user",
        text: "btw keep this as normal prose",
        createdAt: "2026-02-23T00:00:05.000Z",
        streaming: false,
      },
    ]);

    expect(entries.map((entry) => entry.id)).toEqual(["main-message", "normal-btw-message"]);
  });

  it("includes proposed plans alongside messages and work entries in chronological order", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("message-1"),
          role: "assistant",
          text: "hello",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
      ],
      [
        {
          id: "plan:thread-1:turn:turn-1",
          turnId: TurnId.makeUnsafe("turn-1"),
          planMarkdown: "# Ship it",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:02.000Z",
        },
      ],
      [
        {
          id: "work-1",
          createdAt: "2026-02-23T00:00:03.000Z",
          label: "Ran tests",
          tone: "tool",
        },
      ],
    );

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "proposed-plan", "work"]);
    expect(entries[1]).toMatchObject({
      kind: "proposed-plan",
      proposedPlan: {
        planMarkdown: "# Ship it",
        implementedAt: null,
        implementationThreadId: null,
      },
    });
  });

  it("keeps work entries in activity sequence order when timestamps drift", () => {
    const entries = deriveTimelineEntries(
      [],
      [],
      [
        {
          id: "work-2",
          createdAt: "2026-02-23T00:00:03.000Z",
          sequence: 2,
          label: "Run command",
          tone: "tool",
        },
        {
          id: "work-1",
          createdAt: "2026-02-23T00:00:04.000Z",
          sequence: 1,
          label: "Read file",
          tone: "tool",
        },
      ],
    );

    expect(entries.map((entry) => entry.id)).toEqual(["work-1", "work-2"]);
  });

  it("orders assistant messages and work entries by sequence when timestamps match", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("assistant-before"),
          role: "assistant",
          text: "Before tool",
          createdAt: "2026-02-23T00:00:03.000Z",
          sequence: 1,
          streaming: false,
        },
        {
          id: MessageId.makeUnsafe("assistant-after"),
          role: "assistant",
          text: "After tool",
          createdAt: "2026-02-23T00:00:03.000Z",
          sequence: 3,
          streaming: false,
        },
      ],
      [],
      [
        {
          id: "work-2",
          createdAt: "2026-02-23T00:00:03.000Z",
          sequence: 2,
          label: "Read file",
          tone: "tool",
        },
      ],
    );

    expect(entries.map((entry) => entry.id)).toEqual([
      "assistant-before",
      "work-2",
      "assistant-after",
    ]);
  });

  it("places work entries before assistant rows when sequence and timestamp tie", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("assistant-complete"),
          role: "assistant",
          text: "",
          createdAt: "2026-02-23T00:00:03.000Z",
          sequence: 9,
          streaming: false,
        },
      ],
      [],
      [
        {
          id: "work-tool",
          createdAt: "2026-02-23T00:00:03.000Z",
          sequence: 9,
          label: "Run command",
          tone: "tool",
        },
      ],
    );

    expect(entries.map((entry) => entry.id)).toEqual(["work-tool", "assistant-complete"]);
  });

  it("orders mixed message and work rows by createdAt when their sequence domains differ", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("assistant-later"),
          role: "assistant",
          text: "Final reply",
          createdAt: "2026-02-23T00:00:03.000Z",
          sequence: 42,
          streaming: false,
        },
      ],
      [],
      [
        {
          id: "work-earlier",
          createdAt: "2026-02-23T00:00:02.000Z",
          sequence: 1_706_255_202_000_001,
          label: "Read file",
          tone: "tool",
        },
      ],
    );

    expect(entries.map((entry) => entry.id)).toEqual(["work-earlier", "assistant-later"]);
  });

  it("lifts report_intent out of the work log and attaches it to the next tool entry", () => {
    const entries = deriveTimelineEntries(
      [],
      [],
      [
        {
          id: "work-intent",
          createdAt: "2026-02-23T00:00:01.000Z",
          label: "Report Intent",
          toolTitle: "Report Intent",
          detail: "Running format and checks",
          tone: "tool",
        },
        {
          id: "work-tool",
          createdAt: "2026-02-23T00:00:02.000Z",
          label: "Run command",
          toolTitle: "Run command",
          detail: "bun fmt && bun lint",
          tone: "tool",
        },
      ],
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      kind: "intent",
      text: "Running format and checks",
    });
    expect(entries[1]).toMatchObject({
      kind: "work",
      entry: {
        intentText: "Running format and checks",
      },
    });
  });

  it("creates an intent row when a tool entry already carries embedded intent metadata", () => {
    const entries = deriveTimelineEntries(
      [],
      [],
      [
        {
          id: "work-tool-with-embedded-intent",
          createdAt: "2026-02-23T00:00:01.000Z",
          label: "Running format & checks",
          toolTitle: "Running format & checks",
          detail: "Formatting and checks completed successfully.",
          tone: "tool",
          intentText: "Running format & checks",
        },
      ],
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      kind: "intent",
      text: "Running format & checks",
    });
    expect(entries[1]).toMatchObject({
      kind: "work",
      entry: {
        toolTitle: "Running format & checks",
        intentText: "Running format & checks",
      },
    });
  });

  it("collapses repeated near-identical report_intent entries into a single timeline intent row", () => {
    const entries = deriveTimelineEntries(
      [],
      [],
      [
        {
          id: "work-intent-1",
          createdAt: "2026-02-23T00:00:01.000Z",
          label: "Report Intent",
          toolTitle: "Report Intent",
          detail: "Running format and checks",
          tone: "tool",
        },
        {
          id: "work-intent-2",
          createdAt: "2026-02-23T00:00:01.100Z",
          label: "Report Intent",
          toolTitle: "Report Intent",
          detail: "Running format and checks.",
          tone: "tool",
        },
        {
          id: "work-tool",
          createdAt: "2026-02-23T00:00:02.000Z",
          label: "Run command",
          toolTitle: "Run command",
          detail: "bun fmt && bun lint",
          tone: "tool",
        },
      ],
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      kind: "intent",
      text: "Running format and checks",
    });
    expect(entries[1]).toMatchObject({
      kind: "work",
      entry: {
        intentText: "Running format and checks.",
      },
    });
  });

  it("normalizes duplicated report_intent text before rendering it in the timeline", () => {
    const entries = deriveTimelineEntries(
      [],
      [],
      [
        {
          id: "work-intent-duplicate-text",
          createdAt: "2026-02-23T00:00:01.000Z",
          label: "Report Intent",
          toolTitle: "Report Intent",
          detail: "Exploring codebase Exploring codebase",
          tone: "tool",
        },
        {
          id: "work-tool-after-duplicate-text",
          createdAt: "2026-02-23T00:00:02.000Z",
          label: "Read file",
          toolTitle: "Read file",
          detail: "src/main.ts",
          tone: "tool",
        },
      ],
    );

    expect(entries[0]).toMatchObject({
      kind: "intent",
      text: "Exploring codebase",
    });
    expect(entries[1]).toMatchObject({
      kind: "work",
      entry: {
        intentText: "Exploring codebase",
      },
    });
  });

  it("keeps short consecutive intent rows separate from the following assistant message", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("assistant-final"),
          role: "assistant",
          text: "I found the root cause in the timeline renderer.",
          createdAt: "2026-02-23T00:00:03.000Z",
          streaming: false,
        },
      ],
      [],
      [
        {
          id: "work-intent-1",
          createdAt: "2026-02-23T00:00:01.000Z",
          label: "Report Intent",
          toolTitle: "Report Intent",
          detail: "Exploring codebase",
          tone: "tool",
        },
        {
          id: "work-intent-2",
          createdAt: "2026-02-23T00:00:02.000Z",
          label: "Report Intent",
          toolTitle: "Report Intent",
          detail: "Tracing timeline state",
          tone: "tool",
        },
      ],
    );

    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      kind: "intent",
      text: "Exploring codebase",
    });
    expect(entries[1]).toMatchObject({
      kind: "intent",
      text: "Tracing timeline state",
    });
    expect(entries[2]).toMatchObject({
      kind: "message",
      message: {
        text: "I found the root cause in the timeline renderer.",
      },
    });
  });

  it("keeps longer intent rows separate from assistant messages", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("assistant-after-long-intent"),
          role: "assistant",
          text: "I can now summarize the migration plan.",
          createdAt: "2026-02-23T00:00:03.000Z",
          streaming: false,
        },
      ],
      [],
      [
        {
          id: "work-intent-long",
          createdAt: "2026-02-23T00:00:01.000Z",
          label: "Report Intent",
          toolTitle: "Report Intent",
          detail:
            "Inspecting all server orchestration boundaries before rewriting the ingestion and projection path.",
          tone: "tool",
        },
      ],
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      kind: "intent",
      text: "Inspecting all server orchestration boundaries before rewriting the ingestion and projection path.",
    });
    expect(entries[1]).toMatchObject({
      kind: "message",
      message: {
        text: "I can now summarize the migration plan.",
      },
    });
  });

  it("does not attach intent text to thinking rows before the next tool call", () => {
    const entries = deriveTimelineEntries(
      [],
      [],
      [
        {
          id: "work-intent",
          createdAt: "2026-02-23T00:00:01.000Z",
          label: "Report Intent",
          toolTitle: "Report Intent",
          detail: "Counting files",
          tone: "tool",
        },
        {
          id: "work-thinking",
          createdAt: "2026-02-23T00:00:02.000Z",
          label: "Reasoning",
          detail: "Checking tracked files first.",
          tone: "thinking",
        },
        {
          id: "work-tool",
          createdAt: "2026-02-23T00:00:03.000Z",
          label: "Run command",
          toolTitle: "Run command",
          detail: "git ls-files",
          tone: "tool",
        },
      ],
    );

    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      kind: "intent",
      text: "Counting files",
    });
    expect(entries[1]).toMatchObject({
      kind: "work",
      entry: {
        tone: "thinking",
      },
    });
    expect(entries[1]).not.toMatchObject({
      kind: "work",
      entry: {
        intentText: "Counting files",
      },
    });
    expect(entries[2]).toMatchObject({
      kind: "work",
      entry: {
        tone: "tool",
        intentText: "Counting files",
      },
    });
  });

  it("anchors the completion divider to latestTurn.assistantMessageId before timestamp fallback", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("assistant-earlier"),
          role: "assistant",
          text: "progress update",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
        {
          id: MessageId.makeUnsafe("assistant-final"),
          role: "assistant",
          text: "final answer",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
      ],
      [],
      [],
    );

    expect(
      deriveCompletionDividerBeforeEntryId(entries, {
        turnId: TurnId.makeUnsafe("turn-1"),
        assistantMessageId: MessageId.makeUnsafe("assistant-final"),
        startedAt: "2026-02-23T00:00:00.000Z",
        completedAt: "2026-02-23T00:00:02.000Z",
      }),
    ).toBe("assistant-final");
  });

  it("anchors the completion divider to the latest assistant message in the active turn", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("assistant-progress"),
          role: "assistant",
          text: "progress update",
          turnId: TurnId.makeUnsafe("turn-active"),
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
        {
          id: MessageId.makeUnsafe("assistant-final"),
          role: "assistant",
          text: "final answer",
          turnId: TurnId.makeUnsafe("turn-active"),
          createdAt: "2026-02-23T00:00:03.000Z",
          streaming: false,
        },
      ],
      [],
      [],
    );

    expect(
      deriveCompletionDividerBeforeEntryId(entries, {
        turnId: TurnId.makeUnsafe("turn-active"),
        assistantMessageId: MessageId.makeUnsafe("assistant-progress"),
        startedAt: "2026-02-23T00:00:00.000Z",
        completedAt: "2026-02-23T00:00:04.000Z",
      }),
    ).toBe("assistant-final");
  });
});

describe("deriveWorkLogEntries context window handling", () => {
  it("excludes context window updates from the work log", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "context-1",
          turnId: "turn-1",
          kind: "context-window.updated",
          summary: "Context window updated",
          tone: "info",
        }),
        makeActivity({
          id: "tool-1",
          turnId: "turn-1",
          kind: "tool.completed",
          summary: "Ran command",
          tone: "tool",
        }),
      ],
      TurnId.makeUnsafe("turn-1"),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Ran command");
  });

  it("keeps context compaction activities as normal work log entries", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "compaction-1",
          turnId: "turn-1",
          kind: "context-compaction",
          summary: "Context compacted",
          tone: "info",
        }),
      ],
      TurnId.makeUnsafe("turn-1"),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Context compacted");
  });
});

describe("deriveVisibleTurnDiffSummaryByAssistantMessageId", () => {
  it("keeps only the last assistant diff summary when it is the latest message", () => {
    const assistantMessageId = MessageId.makeUnsafe("assistant-last");

    expect(
      deriveVisibleTurnDiffSummaryByAssistantMessageId(
        [
          {
            id: MessageId.makeUnsafe("user-first"),
            role: "user",
          },
          {
            id: assistantMessageId,
            role: "assistant",
          },
        ],
        [
          {
            turnId: TurnId.makeUnsafe("turn-last"),
            assistantMessageId,
            completedAt: "2026-02-23T00:00:02.000Z",
            files: [{ path: "apps/web/src/components/chat/MessagesTimeline.tsx" }],
          },
          {
            turnId: TurnId.makeUnsafe("turn-earlier"),
            assistantMessageId: MessageId.makeUnsafe("assistant-earlier"),
            completedAt: "2026-02-23T00:00:01.000Z",
            files: [{ path: "apps/web/src/components/ChatView.tsx" }],
          },
        ],
      ),
    ).toEqual(
      new Map([
        [
          assistantMessageId,
          {
            turnId: TurnId.makeUnsafe("turn-last"),
            assistantMessageId,
            completedAt: "2026-02-23T00:00:02.000Z",
            files: [{ path: "apps/web/src/components/chat/MessagesTimeline.tsx" }],
          },
        ],
      ]),
    );
  });

  it("clears visible diff summaries once a user sends a follow-up message", () => {
    expect(
      deriveVisibleTurnDiffSummaryByAssistantMessageId(
        [
          {
            id: MessageId.makeUnsafe("assistant-with-diff"),
            role: "assistant",
          },
          {
            id: MessageId.makeUnsafe("user-follow-up"),
            role: "user",
          },
        ],
        [
          {
            turnId: TurnId.makeUnsafe("turn-with-diff"),
            assistantMessageId: MessageId.makeUnsafe("assistant-with-diff"),
            completedAt: "2026-02-23T00:00:02.000Z",
            files: [{ path: "apps/web/src/components/chat/ChangedFilesTree.tsx" }],
          },
        ],
      ),
    ).toEqual(new Map());
  });
});

describe("filterVisibleWorkLogActivities", () => {
  it("removes hidden tool and thinking activities when both visibility toggles are disabled", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-complete",
        kind: "tool.completed",
        summary: "Tool completed",
        tone: "tool",
      }),
      makeActivity({
        id: "hook-progress",
        kind: "hook.progress",
        summary: "Hook output",
        tone: "tool",
      }),
      makeActivity({
        id: "task-progress",
        kind: "task.progress",
        summary: "Reasoning update",
        tone: "info",
      }),
      makeActivity({
        id: "plan-updated",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
      }),
      makeActivity({
        id: "runtime-warning",
        kind: "runtime.warning",
        summary: "Runtime warning",
        tone: "info",
      }),
    ];

    const visible = filterVisibleWorkLogActivities(activities, {
      enableToolStreaming: false,
      enableThinkingStreaming: false,
    });

    expect(visible.map((activity) => activity.id)).toEqual(["runtime-warning"]);
  });

  it("still removes goal lifecycle activities when both visibility toggles are enabled", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "tool-complete", kind: "tool.completed", tone: "tool" }),
      makeActivity({
        id: "goal-tool",
        kind: "tool.completed",
        summary: "Tool call complete",
        tone: "tool",
        payload: {
          title: "update_goal",
          data: {
            result: {
              objective: "Implement provider feature parity",
              status: "active",
            },
          },
        },
      }),
    ];

    const visible = filterVisibleWorkLogActivities(activities, {
      enableToolStreaming: true,
      enableThinkingStreaming: true,
    });

    expect(visible.map((activity) => activity.id)).toEqual(["tool-complete"]);
  });

  it("removes MCP provider status activities from the work log", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "tool-complete", kind: "tool.completed", tone: "tool" }),
      makeActivity({
        id: "mcp-status",
        kind: "mcp.status.updated",
        summary: "MCP status updated",
        tone: "info",
        payload: { status: [{ name: "browser", status: "tools_changed" }] },
      }),
      makeActivity({
        id: "mcp-oauth",
        kind: "mcp.oauth.completed",
        summary: "MCP OAuth completed",
        tone: "info",
        payload: { name: "schema-docs", success: true },
      }),
      makeActivity({
        id: "provider-config",
        kind: "config.warning",
        summary: "Provider configuration warning",
        tone: "info",
        payload: { provider: "codex", summary: "Unsupported config key" },
      }),
      makeActivity({
        id: "provider-rate-limit",
        kind: "account.rate-limits.updated",
        summary: "Provider rate limits updated",
        tone: "info",
        payload: { provider: "githubCopilot", rateLimits: { remaining: 0, limit: 500 } },
      }),
    ];

    const visible = filterVisibleWorkLogActivities(activities, {
      enableToolStreaming: true,
      enableThinkingStreaming: true,
    });

    expect(visible.map((activity) => activity.id)).toEqual(["tool-complete"]);
  });
});

describe("deriveEnvironmentMcpStatuses", () => {
  it("derives latest provider MCP state and sorts failing servers first", () => {
    const statuses = deriveEnvironmentMcpStatuses([
      makeActivity({
        id: "schema-docs-old",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "mcp.status.updated",
        summary: "MCP status updated",
        payload: {
          provider: "codex",
          status: [{ name: "schema-docs", status: "tools_changed", scope: "initial tools" }],
        },
      }),
      makeActivity({
        id: "schema-docs-new",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "mcp.status.updated",
        summary: "MCP status updated",
        payload: {
          provider: "codex",
          status: [{ name: "schema-docs", status: "ready", scope: "latest tools" }],
        },
      }),
      makeActivity({
        id: "schema-docs-claude",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "mcp.status.updated",
        summary: "MCP status updated",
        payload: {
          provider: "claudeAgent",
          status: [{ name: "schema-docs", status: "needs_auth", reason: "login required" }],
        },
      }),
      makeActivity({
        id: "browser-oauth",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "mcp.oauth.completed",
        summary: "MCP OAuth completed",
        payload: {
          provider: "opencode",
          name: "browser",
          success: false,
          error: "OAuth callback failed",
        },
      }),
    ]);

    expect(statuses).toEqual([
      {
        id: "browser-oauth:OpenCode:browser",
        createdAt: "2026-02-23T00:00:02.000Z",
        name: "browser",
        providerLabel: "OpenCode",
        status: "authentication failed",
        tone: "error",
        detail: "OAuth callback failed",
      },
      {
        id: "schema-docs-claude:Claude:schema-docs",
        createdAt: "2026-02-23T00:00:04.000Z",
        name: "schema-docs",
        providerLabel: "Claude",
        status: "needs auth",
        tone: "error",
        detail: "login required",
      },
      {
        id: "schema-docs-new:Codex:schema-docs",
        createdAt: "2026-02-23T00:00:03.000Z",
        name: "schema-docs",
        providerLabel: "Codex",
        status: "ready",
        tone: "info",
        detail: "latest tools",
      },
    ]);
  });

  it("derives MCP state from provider map and nested server containers", () => {
    const statuses = deriveEnvironmentMcpStatuses([
      makeActivity({
        id: "cursor-mcp-map",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "mcp.status.updated",
        summary: "MCP status updated",
        payload: {
          provider: "cursor",
          status: {
            filesystem: {
              state: "ready",
              message: "3 tools",
            },
            browser: {
              phase: "needs_client_registration",
              error: "OAuth client missing",
            },
          },
        },
      }),
      makeActivity({
        id: "gemini-mcp-container",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "mcp.status.updated",
        summary: "MCP status updated",
        payload: {
          provider: "gemini",
          servers: {
            docs: {
              status: "tools_changed",
              detail: "new tool list",
            },
          },
        },
      }),
    ]);

    expect(statuses).toEqual([
      {
        id: "cursor-mcp-map:Cursor:browser",
        createdAt: "2026-02-23T00:00:01.000Z",
        name: "browser",
        providerLabel: "Cursor",
        status: "needs client registration",
        tone: "error",
        detail: "OAuth client missing",
      },
      {
        id: "gemini-mcp-container:Gemini:docs",
        createdAt: "2026-02-23T00:00:02.000Z",
        name: "docs",
        providerLabel: "Gemini",
        status: "tools changed",
        tone: "info",
        detail: "new tool list",
      },
      {
        id: "cursor-mcp-map:Cursor:filesystem",
        createdAt: "2026-02-23T00:00:01.000Z",
        name: "filesystem",
        providerLabel: "Cursor",
        status: "ready",
        tone: "info",
        detail: "3 tools",
      },
    ]);
  });
});

describe("deriveEnvironmentProviderStatuses", () => {
  it("derives provider health and config rows sorted by severity", () => {
    const statuses = deriveEnvironmentProviderStatuses([
      makeActivity({
        id: "codex-account",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "account.updated",
        summary: "Provider account updated",
        payload: {
          provider: "codex",
          account: { email: "dev@example.com" },
        },
      }),
      makeActivity({
        id: "codex-reroute",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "model.rerouted",
        summary: "Model rerouted",
        payload: {
          provider: "codex",
          fromModel: "gpt-5",
          toModel: "gpt-5.4",
          reason: "requested model unavailable",
        },
      }),
      makeActivity({
        id: "claude-auth",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "auth.status",
        summary: "Provider auth status",
        payload: {
          provider: "claudeAgent",
          error: "OAuth expired",
        },
      }),
      makeActivity({
        id: "cursor-auth",
        createdAt: "2026-02-23T00:00:03.500Z",
        kind: "auth.status",
        summary: "Provider auth status",
        payload: {
          provider: "cursor",
          status: "authenticated",
          label: "dev@cursor.example",
        },
      }),
      makeActivity({
        id: "opencode-auth",
        createdAt: "2026-02-23T00:00:03.750Z",
        kind: "auth.status",
        summary: "Provider auth status",
        payload: {
          provider: "opencode",
          output: ["Not logged in"],
        },
      }),
      makeActivity({
        id: "pi-config",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "config.warning",
        summary: "Provider configuration warning",
        payload: {
          provider: "pi",
          summary: "Unsupported config key",
          path: "/repo/pi.json",
        },
      }),
      makeActivity({
        id: "copilot-rate-limit",
        createdAt: "2026-02-23T00:00:04.500Z",
        kind: "account.rate-limits.updated",
        summary: "Provider rate limits updated",
        payload: {
          provider: "githubCopilot",
          rateLimits: {
            remaining: 0,
            limit: 500,
            reset_at: "2026-02-23T01:00:00.000Z",
          },
        },
      }),
      makeActivity({
        id: "gemini-runtime-error",
        createdAt: "2026-02-23T00:00:05.000Z",
        kind: "runtime.error",
        summary: "Runtime error",
        payload: {
          provider: "gemini",
          message: "Browser MCP failed to open",
          detail: "Timed out waiting for localhost preview",
        },
      }),
      makeActivity({
        id: "opencode-runtime-warning",
        createdAt: "2026-02-23T00:00:06.000Z",
        kind: "runtime.warning",
        summary: "Runtime warning",
        payload: {
          provider: "opencode",
          message: "MCP tools changed",
        },
      }),
    ]);

    expect(statuses).toEqual([
      {
        id: "claude-auth:auth.status",
        createdAt: "2026-02-23T00:00:03.000Z",
        label: "Claude auth",
        status: "authentication error",
        tone: "error",
        detail: "OAuth expired",
      },
      {
        id: "gemini-runtime-error:runtime.error",
        createdAt: "2026-02-23T00:00:05.000Z",
        label: "Gemini runtime",
        status: "Browser MCP failed to open",
        tone: "error",
        detail: "Timed out waiting for localhost preview",
      },
      {
        id: "codex-reroute:model.rerouted",
        createdAt: "2026-02-23T00:00:02.000Z",
        label: "Codex model",
        status: "gpt-5 -> gpt-5.4",
        tone: "warning",
        detail: "requested model unavailable",
      },
      {
        id: "copilot-rate-limit:account.rate-limits.updated",
        createdAt: "2026-02-23T00:00:04.500Z",
        label: "Copilot limits",
        status: "0/500 remaining",
        tone: "warning",
        detail: "2026-02-23T01:00:00.000Z",
      },
      {
        id: "opencode-auth:auth.status",
        createdAt: "2026-02-23T00:00:03.750Z",
        label: "OpenCode auth",
        status: "not authenticated",
        tone: "warning",
        detail: "Not logged in",
      },
      {
        id: "opencode-runtime-warning:runtime.warning",
        createdAt: "2026-02-23T00:00:06.000Z",
        label: "OpenCode runtime",
        status: "MCP tools changed",
        tone: "warning",
      },
      {
        id: "pi-config:config.warning",
        createdAt: "2026-02-23T00:00:04.000Z",
        label: "Pi config",
        status: "Unsupported config key",
        tone: "warning",
        detail: "/repo/pi.json",
      },
      {
        id: "codex-account:account.updated",
        createdAt: "2026-02-23T00:00:01.000Z",
        label: "Codex account",
        status: "dev@example.com",
        tone: "info",
      },
      {
        id: "cursor-auth:auth.status",
        createdAt: "2026-02-23T00:00:03.500Z",
        label: "Cursor auth",
        status: "dev@cursor.example",
        tone: "info",
      },
    ]);
  });
});

describe("deriveEnvironmentSessionProviderStatus", () => {
  it("describes active session multi-agent capability modes", () => {
    expect(
      deriveEnvironmentSessionProviderStatus({
        provider: "codex",
        updatedAt: "2026-02-23T00:00:07.000Z",
        capabilities: { multiAgentMode: "native" },
      }),
    ).toEqual({
      id: "codex:multi-agent-capability",
      createdAt: "2026-02-23T00:00:07.000Z",
      label: "Codex agents",
      status: "native",
      tone: "info",
      detail: "Provider can run multi-agent delegation natively.",
    });

    expect(
      deriveEnvironmentSessionProviderStatus({
        provider: "cursor",
        updatedAt: "2026-02-23T00:00:08.000Z",
        capabilities: {
          multiAgentMode: "agent-command",
          multiAgentInvocationPrefixes: ["@", "/agent"],
          multiAgentDefinitionPaths: [".cursor/agents/*.md", "~/.cursor/agents/*.md"],
          multiAgentManagementCommands: ["/agents list", "/agents reload"],
        },
      }),
    ).toEqual({
      id: "cursor:multi-agent-capability",
      createdAt: "2026-02-23T00:00:08.000Z",
      label: "Cursor agents",
      status: "command",
      tone: "info",
      detail:
        "Provider agents are available through command or mention routing.\nInvoke: @, /agent\nDefinitions: .cursor/agents/*.md, ~/.cursor/agents/*.md\nManage: /agents list, /agents reload",
    });

    expect(
      deriveEnvironmentSessionProviderStatus({
        provider: "pi",
        updatedAt: "2026-02-23T00:00:09.000Z",
        capabilities: { multiAgentMode: "unsupported" },
      }),
    ).toEqual({
      id: "pi:multi-agent-capability",
      createdAt: "2026-02-23T00:00:09.000Z",
      label: "Pi agents",
      status: "unsupported",
      tone: "warning",
      detail: "Provider has not advertised multi-agent delegation.",
    });
  });

  it("summarizes discovered provider agents separately from static capability metadata", () => {
    expect(
      deriveEnvironmentSessionProviderStatuses(
        {
          provider: "githubCopilot",
          updatedAt: "2026-02-23T00:00:09.500Z",
          capabilities: { multiAgentMode: "native" },
        },
        [
          {
            name: "reviewer",
            kind: "agent",
            promptPrefix: "@reviewer",
            description: "Review the current diff.",
          },
          {
            name: "reviewer",
            kind: "agent",
            promptPrefix: "@reviewer",
            description: "Duplicate provider report.",
          },
          {
            name: "planner",
            kind: "provider",
            promptPrefix: "@planner",
          },
          {
            name: "agent:architect",
            kind: "provider",
            description: "Use the provider architecture agent.",
          },
          {
            name: "docs",
            kind: "skill",
            promptPrefix: "$docs",
          },
          {
            name: ".side",
            kind: "agent",
            promptPrefix: ".side",
          },
          {
            name: "workspace-helper",
            promptPrefix: "@workspace-helper",
          },
        ],
      ),
    ).toEqual([
      {
        id: "githubCopilot:multi-agent-capability",
        createdAt: "2026-02-23T00:00:09.500Z",
        label: "Copilot agents",
        status: "native",
        tone: "info",
        detail: "Provider can run multi-agent delegation natively.",
      },
      {
        id: "githubCopilot:discovered-agent-command:@reviewer",
        createdAt: "2026-02-23T00:00:09.500Z",
        label: "@reviewer",
        status: "agent",
        tone: "info",
        detail: "Review the current diff.",
        action: {
          kind: "composer-prompt",
          label: "Invoke @reviewer",
          prompt: "@reviewer ",
        },
      },
      {
        id: "githubCopilot:discovered-agent-command:@agent:architect",
        createdAt: "2026-02-23T00:00:09.500Z",
        label: "@agent:architect",
        status: "agent",
        tone: "info",
        detail: "Use the provider architecture agent.",
        action: {
          kind: "composer-prompt",
          label: "Invoke @agent:architect",
          prompt: "@agent:architect ",
        },
      },
    ]);
  });

  it("omits session provider status when capabilities are unavailable", () => {
    expect(deriveEnvironmentSessionProviderStatus(null)).toBeNull();
    expect(
      deriveEnvironmentSessionProviderStatus({
        provider: "codex",
        updatedAt: "2026-02-23T00:00:07.000Z",
      }),
    ).toBeNull();
  });

  it("describes side chat, child-thread targeting, and goal controls separately", () => {
    expect(
      deriveEnvironmentSessionProviderStatuses({
        provider: "codex",
        updatedAt: "2026-02-23T00:00:10.500Z",
        capabilities: {
          sideConversationMode: "native-fork",
          sideConversationCommands: [".side", "/btw"],
          providerThreadTargetingMode: "native",
          goalControlMode: "native",
        },
      }),
    ).toEqual([
      {
        id: "codex:side-chat-capability",
        createdAt: "2026-02-23T00:00:10.500Z",
        label: "Codex side chats",
        status: "native",
        tone: "info",
        detail:
          "Ace /side starts a separate side chat through this provider's native fork support.",
      },
      {
        id: "codex:thread-targeting-capability",
        createdAt: "2026-02-23T00:00:10.500Z",
        label: "Codex child threads",
        status: "native",
        tone: "info",
        detail: "Ace can send follow-up messages directly to provider-managed child threads.",
      },
      {
        id: "codex:goal-control-capability",
        createdAt: "2026-02-23T00:00:10.500Z",
        label: "Codex goals",
        status: "native",
        tone: "info",
        detail: "Provider exposes native goal create, update, pause, resume, and clear controls.",
      },
    ]);

    expect(
      deriveEnvironmentSessionProviderStatus({
        provider: "githubCopilot",
        updatedAt: "2026-02-23T00:00:10.750Z",
        capabilities: { sideConversationMode: "replay-fork" },
      }),
    ).toEqual({
      id: "githubCopilot:side-chat-capability",
      createdAt: "2026-02-23T00:00:10.750Z",
      label: "Copilot side chats",
      status: "replay",
      tone: "info",
      detail:
        "Ace /side starts a separate side chat by replaying bounded parent context into a separate provider session.",
    });

    expect(
      deriveEnvironmentSessionProviderStatus({
        provider: "cursor",
        updatedAt: "2026-02-23T00:00:11.000Z",
        capabilities: {
          sideConversationMode: "native-side-thread",
          sideConversationCommands: ["/ask-side"],
        },
      }),
    ).toEqual({
      id: "cursor:side-chat-capability",
      createdAt: "2026-02-23T00:00:11.000Z",
      label: "Cursor side chats",
      status: "native",
      tone: "info",
      detail:
        "Ace /side starts a separate side chat through this provider's native side-thread support.",
    });
  });

  it("does not show stale multi-agent metadata for unsupported provider agents", () => {
    expect(
      deriveEnvironmentSessionProviderStatus({
        provider: "gemini",
        updatedAt: "2026-02-23T00:00:11.500Z",
        capabilities: {
          multiAgentMode: "unsupported",
          multiAgentInvocationPrefixes: ["@"],
          multiAgentDefinitionPaths: [".gemini/agents/*.md"],
          multiAgentManagementCommands: ["/agents list"],
        },
      }),
    ).toEqual({
      id: "gemini:multi-agent-capability",
      createdAt: "2026-02-23T00:00:11.500Z",
      label: "Gemini agents",
      status: "unsupported",
      tone: "warning",
      detail: "Provider has not advertised multi-agent delegation.",
    });
  });

  it("describes active session hook capability separately from agents", () => {
    expect(
      deriveEnvironmentSessionProviderStatuses({
        provider: "claudeAgent",
        updatedAt: "2026-02-23T00:00:10.000Z",
        capabilities: {
          multiAgentMode: "native",
          hookMode: "native",
          extensionMode: "native",
          mcpMode: "native",
          remoteAgentMode: "native",
          hostedSessionMode: "native",
          webAccessMode: "native",
        },
      }),
    ).toEqual([
      {
        id: "claudeAgent:multi-agent-capability",
        createdAt: "2026-02-23T00:00:10.000Z",
        label: "Claude agents",
        status: "native",
        tone: "info",
        detail: "Provider can run multi-agent delegation natively.",
      },
      {
        id: "claudeAgent:hook-capability",
        createdAt: "2026-02-23T00:00:10.000Z",
        label: "Claude hooks",
        status: "native",
        tone: "info",
        detail: "Provider can run configured lifecycle hooks.",
      },
      {
        id: "claudeAgent:extension-capability",
        createdAt: "2026-02-23T00:00:10.000Z",
        label: "Claude extensions",
        status: "native",
        tone: "info",
        detail: "Provider supports configured skills, plugins, extensions, or custom agents.",
      },
      {
        id: "claudeAgent:mcp-capability",
        createdAt: "2026-02-23T00:00:10.000Z",
        label: "Claude MCP",
        status: "native",
        tone: "info",
        detail: "Provider can use configured MCP servers and external tool connectors.",
      },
      {
        id: "claudeAgent:remote-agent-capability",
        createdAt: "2026-02-23T00:00:10.000Z",
        label: "Claude remote agents",
        status: "native",
        tone: "info",
        detail: "Provider can delegate to hosted, cloud, or remote A2A agents.",
      },
      {
        id: "claudeAgent:hosted-session-capability",
        createdAt: "2026-02-23T00:00:10.000Z",
        label: "Claude hosted sessions",
        status: "native",
        tone: "info",
        detail: "Provider can run hosted, cloud, or background coding sessions.",
      },
      {
        id: "claudeAgent:web-access-capability",
        createdAt: "2026-02-23T00:00:10.000Z",
        label: "Claude web access",
        status: "native",
        tone: "info",
        detail: "Provider can use first-party web search, web fetch, or browsing tools.",
      },
    ]);

    expect(
      deriveEnvironmentSessionProviderStatuses({
        provider: "cursor",
        updatedAt: "2026-02-23T00:00:11.000Z",
        capabilities: { hookMode: "unsupported" },
      }),
    ).toEqual([
      {
        id: "cursor:hook-capability",
        createdAt: "2026-02-23T00:00:11.000Z",
        label: "Cursor hooks",
        status: "unsupported",
        tone: "warning",
        detail: "Provider has not advertised lifecycle hooks.",
      },
    ]);

    expect(
      deriveEnvironmentSessionProviderStatuses({
        provider: "cursor",
        updatedAt: "2026-02-23T00:00:12.000Z",
        capabilities: { extensionMode: "local-discovery", mcpMode: "local-discovery" },
      }),
    ).toEqual([
      {
        id: "cursor:extension-capability",
        createdAt: "2026-02-23T00:00:12.000Z",
        label: "Cursor extensions",
        status: "local",
        tone: "info",
        detail:
          "Ace exposes locally discovered provider skills, instructions, or extension commands.",
      },
      {
        id: "cursor:mcp-capability",
        createdAt: "2026-02-23T00:00:12.000Z",
        label: "Cursor MCP",
        status: "local",
        tone: "info",
        detail: "Ace exposes locally discovered MCP server configuration.",
      },
    ]);
  });

  it("describes hosted remote agent support separately from local agent delegation", () => {
    expect(
      deriveEnvironmentSessionProviderStatuses({
        provider: "gemini",
        updatedAt: "2026-02-23T00:00:13.000Z",
        capabilities: { remoteAgentMode: "local-bridge" },
      }),
    ).toEqual([
      {
        id: "gemini:remote-agent-capability",
        createdAt: "2026-02-23T00:00:13.000Z",
        label: "Gemini remote agents",
        status: "bridge",
        tone: "info",
        detail: "Ace can bridge provider sessions to remote agent endpoints.",
      },
    ]);

    expect(
      deriveEnvironmentSessionProviderStatuses({
        provider: "opencode",
        updatedAt: "2026-02-23T00:00:14.000Z",
        capabilities: { remoteAgentMode: "unsupported" },
      }),
    ).toEqual([
      {
        id: "opencode:remote-agent-capability",
        createdAt: "2026-02-23T00:00:14.000Z",
        label: "OpenCode remote agents",
        status: "unsupported",
        tone: "warning",
        detail: "Provider has not advertised hosted or remote agent delegation.",
      },
    ]);
  });

  it("describes provider web access separately from MCP and subagents", () => {
    expect(
      deriveEnvironmentSessionProviderStatuses({
        provider: "githubCopilot",
        updatedAt: "2026-02-23T00:00:15.000Z",
        capabilities: { webAccessMode: "agent-command" },
      }),
    ).toEqual([
      {
        id: "githubCopilot:web-access-capability",
        createdAt: "2026-02-23T00:00:15.000Z",
        label: "Copilot web access",
        status: "command",
        tone: "info",
        detail: "Provider exposes web research through a command or agent route.",
      },
    ]);

    expect(
      deriveEnvironmentSessionProviderStatuses({
        provider: "opencode",
        updatedAt: "2026-02-23T00:00:16.000Z",
        capabilities: { webAccessMode: "mcp-or-shell" },
      }),
    ).toEqual([
      {
        id: "opencode:web-access-capability",
        createdAt: "2026-02-23T00:00:16.000Z",
        label: "OpenCode web access",
        status: "tool",
        tone: "info",
        detail: "Provider can reach web context through MCP tools or shell/network access.",
      },
    ]);

    expect(
      deriveEnvironmentSessionProviderStatuses({
        provider: "pi",
        updatedAt: "2026-02-23T00:00:17.000Z",
        capabilities: { webAccessMode: "unsupported" },
      }),
    ).toEqual([
      {
        id: "pi:web-access-capability",
        createdAt: "2026-02-23T00:00:17.000Z",
        label: "Pi web access",
        status: "unsupported",
        tone: "warning",
        detail: "Provider has not advertised web search or web fetch support.",
      },
    ]);
  });

  it("describes provider hosted sessions separately from remote agents", () => {
    expect(
      deriveEnvironmentSessionProviderStatuses({
        provider: "codex",
        updatedAt: "2026-02-23T00:00:18.000Z",
        capabilities: { hostedSessionMode: "local-bridge" },
      }),
    ).toEqual([
      {
        id: "codex:hosted-session-capability",
        createdAt: "2026-02-23T00:00:18.000Z",
        label: "Codex hosted sessions",
        status: "bridge",
        tone: "info",
        detail: "Provider can bridge Ace to a remotely controlled local provider session.",
      },
    ]);

    expect(
      deriveEnvironmentSessionProviderStatuses({
        provider: "pi",
        updatedAt: "2026-02-23T00:00:19.000Z",
        capabilities: { hostedSessionMode: "unsupported" },
      }),
    ).toEqual([
      {
        id: "pi:hosted-session-capability",
        createdAt: "2026-02-23T00:00:19.000Z",
        label: "Pi hosted sessions",
        status: "unsupported",
        tone: "warning",
        detail: "Provider has not advertised hosted or background sessions.",
      },
    ]);
  });
});

describe("deriveActiveGoalState", () => {
  it("tracks the latest provider-confirmed active goal and clears it", () => {
    const activeGoalActivity = makeActivity({
      id: "goal-active",
      createdAt: "2026-02-23T00:00:01.000Z",
      kind: "goal.updated",
      summary: "Goal updated",
      tone: "info",
      payload: {
        threadId: "provider-thread-1",
        objective: "Implement the goal panel",
        status: "active",
        tokenBudget: 2000,
        tokensUsed: 125,
      },
    });
    const pausedGoalActivity = makeActivity({
      id: "goal-paused",
      createdAt: "2026-02-23T00:00:02.000Z",
      kind: "goal.updated",
      summary: "Goal paused",
      tone: "info",
      payload: {
        threadId: "provider-thread-1",
        objective: "Implement the goal panel",
        status: "paused",
        tokensUsed: 200,
      },
    });

    expect(deriveActiveGoalState([activeGoalActivity, pausedGoalActivity])).toEqual({
      createdAt: "2026-02-23T00:00:02.000Z",
      threadId: "provider-thread-1",
      objective: "Implement the goal panel",
      status: "paused",
      tokensUsed: 200,
    });
    expect(
      deriveActiveGoalState([
        activeGoalActivity,
        pausedGoalActivity,
        makeActivity({
          id: "goal-cleared",
          createdAt: "2026-02-23T00:00:03.000Z",
          kind: "goal.cleared",
          summary: "Goal cleared",
          tone: "info",
        }),
      ]),
    ).toBeNull();
  });

  it("derives the active goal from lifecycle tool payloads without rendering transcript noise", () => {
    const goalToolActivity = makeActivity({
      id: "goal-tool-result",
      createdAt: "2026-02-23T00:00:01.000Z",
      kind: "reasoning.completed",
      summary: "Thinking",
      tone: "info",
      payload: {
        data: {
          item: {
            title: "✓ Goal updated",
            result: {
              objective: "Implement provider feature parity",
              status: "active",
              tokensUsed: 42,
            },
          },
        },
      },
    });

    expect(deriveWorkLogEntries([goalToolActivity], undefined)).toEqual([]);
    expect(deriveActiveGoalState([goalToolActivity])).toEqual({
      createdAt: "2026-02-23T00:00:01.000Z",
      threadId: "active-thread",
      objective: "Implement provider feature parity",
      status: "active",
      tokensUsed: 42,
    });
  });

  it("normalizes completed provider goal aliases for the active goal panel", () => {
    const goalToolActivity = makeActivity({
      id: "goal-tool-complete-result",
      createdAt: "2026-02-23T00:00:01.000Z",
      kind: "reasoning.completed",
      summary: "Thinking",
      tone: "info",
      payload: {
        data: {
          item: {
            title: "Goal updated",
            result: {
              objective: "Finish provider feature parity",
              status: "complete",
            },
          },
        },
      },
    });

    expect(deriveWorkLogEntries([goalToolActivity], undefined)).toEqual([]);
    expect(deriveActiveGoalState([goalToolActivity])).toEqual({
      createdAt: "2026-02-23T00:00:01.000Z",
      threadId: "active-thread",
      objective: "Finish provider feature parity",
      status: "completed",
    });
  });
});

describe("deriveLatestGeneratedWorkspaceSummary", () => {
  it("returns the latest generated workspace summary", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "summary-turn-1",
        turnId: "turn-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "workspace.summary.generated",
        summary: "Turn one summary",
        tone: "info",
        payload: {
          headline: "Turn one summary",
          summary: "Completed the first turn.",
          keyChanges: ["Updated one file"],
          risks: [],
        },
      }),
      makeActivity({
        id: "summary-turn-2",
        turnId: "turn-2",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "workspace.summary.generated",
        summary: "Turn two summary",
        tone: "info",
        payload: {
          headline: "Turn two summary",
          summary: "Completed the second turn.",
          keyChanges: ["Updated two files"],
          risks: ["Tests not run"],
        },
      }),
    ];

    const summary = deriveLatestGeneratedWorkspaceSummary(activities);

    expect(summary?.headline).toBe("Turn two summary");
    expect(summary?.markdown).toContain("### Turn two summary");
    expect(summary?.markdown).toContain("#### Key changes");
    expect(summary?.markdown).toContain("- Updated two files");
    expect(summary?.markdown).toContain("#### Watchouts");
    expect(summary?.markdown).toContain("- Tests not run");
  });
});

describe("hasToolActivityForTurn", () => {
  it("returns false when turn id is missing", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "tool-1", turnId: "turn-1", kind: "tool.completed", tone: "tool" }),
    ];

    expect(hasToolActivityForTurn(activities, undefined)).toBe(false);
    expect(hasToolActivityForTurn(activities, null)).toBe(false);
  });

  it("returns true only for matching tool activity in the target turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "tool-1", turnId: "turn-1", kind: "tool.completed", tone: "tool" }),
      makeActivity({ id: "info-1", turnId: "turn-2", kind: "turn.completed", tone: "info" }),
    ];

    expect(hasToolActivityForTurn(activities, TurnId.makeUnsafe("turn-1"))).toBe(true);
    expect(hasToolActivityForTurn(activities, TurnId.makeUnsafe("turn-2"))).toBe(false);
  });
});

describe("isLatestTurnSettled", () => {
  const latestTurn = {
    turnId: TurnId.makeUnsafe("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("returns false while the same turn is still active in a running session", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "running",
        activeTurnId: TurnId.makeUnsafe("turn-1"),
      }),
    ).toBe(false);
  });

  it("returns false while any turn is running to avoid stale latest-turn banners", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "running",
        activeTurnId: TurnId.makeUnsafe("turn-2"),
      }),
    ).toBe(false);
  });

  it("returns true once the session is no longer running that turn", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "ready",
        activeTurnId: undefined,
      }),
    ).toBe(true);
  });

  it("returns false when turn timestamps are incomplete", () => {
    expect(
      isLatestTurnSettled(
        {
          turnId: TurnId.makeUnsafe("turn-1"),
          startedAt: null,
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        null,
      ),
    ).toBe(false);
  });
});

describe("deriveActiveWorkStartedAt", () => {
  const latestTurn = {
    turnId: TurnId.makeUnsafe("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("prefers the in-flight turn start when the latest turn is not settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          orchestrationStatus: "running",
          activeTurnId: TurnId.makeUnsafe("turn-1"),
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:10:00.000Z");
  });

  it("falls back to sendStartedAt once the latest turn is settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          orchestrationStatus: "ready",
          activeTurnId: undefined,
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });

  it("uses sendStartedAt for a fresh send after the prior turn completed", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          turnId: TurnId.makeUnsafe("turn-1"),
          startedAt: "2026-02-27T21:10:00.000Z",
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        null,
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });
});

describe("deriveVisibleWorkTurnId", () => {
  const runningSession = {
    orchestrationStatus: "running" as const,
    activeTurnId: TurnId.makeUnsafe("turn-2"),
  };

  it("prefers the latest renderable work activity during running turn churn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "turn-1-tool",
        createdAt: "2026-02-27T21:10:01.000Z",
        kind: "tool.completed",
        summary: "Ran tool",
        tone: "tool",
        turnId: "turn-1",
      }),
      makeActivity({
        id: "turn-2-task-started",
        createdAt: "2026-02-27T21:10:02.000Z",
        kind: "task.started",
        summary: "Task started",
        tone: "info",
        turnId: "turn-2",
      }),
    ];

    const visibleTurnId = deriveVisibleWorkTurnId(
      {
        turnId: TurnId.makeUnsafe("turn-2"),
        startedAt: "2026-02-27T21:10:02.000Z",
        completedAt: null,
      },
      runningSession,
      activities,
    );

    expect(visibleTurnId).toBe(TurnId.makeUnsafe("turn-1"));
    expect(deriveWorkLogEntries(activities, visibleTurnId).map((entry) => entry.id)).toEqual([
      "turn-1-tool",
    ]);
  });

  it("falls back to the active session turn when no renderable work activity exists yet", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "turn-2-task-started",
        createdAt: "2026-02-27T21:10:02.000Z",
        kind: "task.started",
        summary: "Task started",
        tone: "info",
        turnId: "turn-2",
      }),
    ];

    expect(
      deriveVisibleWorkTurnId(
        {
          turnId: TurnId.makeUnsafe("turn-2"),
          startedAt: "2026-02-27T21:10:02.000Z",
          completedAt: null,
        },
        runningSession,
        activities,
      ),
    ).toBe(TurnId.makeUnsafe("turn-2"));
  });

  it("uses the settled latest turn once the session is no longer running", () => {
    expect(
      deriveVisibleWorkTurnId(
        {
          turnId: TurnId.makeUnsafe("turn-2"),
          startedAt: "2026-02-27T21:10:02.000Z",
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        {
          orchestrationStatus: "ready",
          activeTurnId: undefined,
        },
        [
          makeActivity({
            id: "turn-1-tool",
            turnId: "turn-1",
            kind: "tool.completed",
            tone: "tool",
          }),
        ],
      ),
    ).toBe(TurnId.makeUnsafe("turn-2"));
  });
});

describe("PROVIDER_OPTIONS", () => {
  it("advertises OpenCode alongside the other available providers", () => {
    const claude = PROVIDER_OPTIONS.find((option) => option.value === "claudeAgent");
    const cursor = PROVIDER_OPTIONS.find((option) => option.value === "cursor");
    const opencode = PROVIDER_OPTIONS.find((option) => option.value === "opencode");
    expect(PROVIDER_OPTIONS).toEqual([
      { value: "codex", label: "Codex", available: true },
      { value: "claudeAgent", label: "Claude", available: true },
      { value: "githubCopilot", label: "Copilot", available: true },
      { value: "cursor", label: "Cursor", available: true },
      { value: "pi", label: "Pi", available: true },
      { value: "gemini", label: "Gemini", available: true },
      { value: "opencode", label: "OpenCode", available: true },
    ]);
    expect(claude).toEqual({
      value: "claudeAgent",
      label: "Claude",
      available: true,
    });
    expect(cursor).toEqual({
      value: "cursor",
      label: "Cursor",
      available: true,
    });
    expect(opencode).toEqual({
      value: "opencode",
      label: "OpenCode",
      available: true,
    });
  });
});
