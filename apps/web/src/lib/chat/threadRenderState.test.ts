import { EventId, type OrchestrationThreadActivity, TurnId } from "@ace/contracts";
import { describe, expect, it } from "vitest";

import { deriveActiveGoalState } from "../../session-logic";
import {
  deriveThreadActivityRenderState,
  deriveThreadTimelineRenderState,
} from "./threadRenderState";

function makeActivity(overrides: {
  id: string;
  kind: OrchestrationThreadActivity["kind"];
  summary: string;
  payload?: Record<string, unknown>;
  tone?: OrchestrationThreadActivity["tone"];
  turnId?: string;
}): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(overrides.id),
    createdAt: "2026-06-05T00:00:00.000Z",
    kind: overrides.kind,
    summary: overrides.summary,
    tone: overrides.tone ?? "info",
    payload: overrides.payload ?? {},
    turnId: overrides.turnId ? TurnId.makeUnsafe(overrides.turnId) : null,
  };
}

describe("threadRenderState", () => {
  it("keeps provider goal lifecycle output out of timeline render state", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "goal-tool-result",
        kind: "reasoning.completed",
        summary: "Thinking",
        payload: {
          data: {
            item: {
              title: "Goal updated",
              result: {
                objective: "Implement provider feature parity without transcript leaks",
                status: "active",
                tokensUsed: 128,
              },
            },
          },
        },
      }),
    ];

    const activityState = deriveThreadActivityRenderState(activities, {
      enableThinkingStreaming: true,
      enableToolStreaming: true,
    });
    const timelineState = deriveThreadTimelineRenderState({
      messages: [],
      proposedPlans: [],
      workLogEntries: activityState.workLogEntries,
      turnDiffSummaries: [],
    });

    expect(activityState.visibleThreadActivities).toEqual([]);
    expect(activityState.workLogEntries).toEqual([]);
    expect(timelineState.timelineEntries).toEqual([]);
    expect(deriveActiveGoalState(activities)).toEqual({
      createdAt: "2026-06-05T00:00:00.000Z",
      threadId: "active-thread",
      objective: "Implement provider feature parity without transcript leaks",
      status: "active",
      tokensUsed: 128,
    });
  });
});
