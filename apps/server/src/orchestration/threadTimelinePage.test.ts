import {
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
} from "@ace/contracts";
import { describe, expect, it } from "vitest";

import { buildThreadTimelinePage } from "./threadTimelinePage";

const threadId = ThreadId.makeUnsafe("thread-timeline-page");
const projectId = ProjectId.makeUnsafe("project-timeline-page");
const turnId = TurnId.makeUnsafe("turn-timeline-page");

function makeThread(): OrchestrationThread {
  return {
    id: threadId,
    projectId,
    title: "Timeline page thread",
    modelSelection: { provider: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:10.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: [
      {
        id: MessageId.makeUnsafe("message-user"),
        role: "user",
        text: "Run checks",
        turnId,
        streaming: false,
        sequence: 1,
        createdAt: "2026-01-01T00:00:01.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: MessageId.makeUnsafe("message-assistant"),
        role: "assistant",
        text: "Done",
        turnId,
        streaming: false,
        sequence: 4,
        createdAt: "2026-01-01T00:00:04.000Z",
        updatedAt: "2026-01-01T00:00:04.000Z",
      },
    ],
    proposedPlans: [
      {
        id: "plan-1",
        turnId,
        planMarkdown: "Plan",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: "2026-01-01T00:00:03.000Z",
        updatedAt: "2026-01-01T00:00:03.000Z",
      },
    ],
    latestProposedPlanSummary: null,
    queuedComposerMessages: [],
    queuedSteerRequest: null,
    activities: [
      {
        id: EventId.makeUnsafe("activity-tool"),
        tone: "tool",
        kind: "tool.completed",
        summary: "Run command",
        payload: {},
        turnId,
        sequence: 2,
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ],
    checkpoints: [],
    session: null,
  };
}

describe("buildThreadTimelinePage", () => {
  it("returns an ordered sparse page with per-kind bodies", () => {
    const page = buildThreadTimelinePage(makeThread(), { startIndex: 1, limit: 2 });

    expect(page).toMatchObject({
      threadId,
      totalItems: 4,
      startIndex: 1,
      endIndexExclusive: 3,
      hasPrevious: true,
      hasNext: true,
    });
    expect(page.entries.map((entry) => `${entry.kind}:${entry.id}`)).toEqual([
      "activity:activity-tool",
      "proposed-plan:plan-1",
    ]);
    expect(page.messages).toHaveLength(0);
    expect(page.activities.map((activity) => activity.id)).toEqual([
      EventId.makeUnsafe("activity-tool"),
    ]);
    expect(page.proposedPlans.map((plan) => plan.id)).toEqual(["plan-1"]);
  });

  it("clamps out-of-range starts to an empty tail page", () => {
    const page = buildThreadTimelinePage(makeThread(), { startIndex: 99, limit: 32 });

    expect(page.startIndex).toBe(4);
    expect(page.endIndexExclusive).toBe(4);
    expect(page.entries).toHaveLength(0);
    expect(page.hasPrevious).toBe(true);
    expect(page.hasNext).toBe(false);
  });
});
