import {
  CheckpointRef,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
} from "@ace/contracts";
import { describe, expect, it } from "vitest";

import { createReadModelSnapshotView } from "./readModelSnapshotView.ts";

const NOW = "2026-04-05T00:00:00.000Z";
const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const THREAD_ONE_ID = ThreadId.makeUnsafe("thread-1");
const THREAD_TWO_ID = ThreadId.makeUnsafe("thread-2");
const TURN_ID = TurnId.makeUnsafe("turn-1");

function makeThread(
  threadId: ThreadId,
  overrides: Partial<OrchestrationReadModel["threads"][number]> = {},
): OrchestrationReadModel["threads"][number] {
  return {
    id: threadId,
    projectId: PROJECT_ID,
    title: `Thread ${threadId}`,
    modelSelection: {
      provider: "codex",
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    deletedAt: null,
    messages: [
      {
        id: MessageId.makeUnsafe(`${threadId}-user-message`),
        role: "user" as const,
        text: "User message",
        turnId: TURN_ID,
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: MessageId.makeUnsafe(`${threadId}-assistant-message`),
        role: "assistant" as const,
        text: "Assistant message",
        turnId: TURN_ID,
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    proposedPlans: [
      {
        id: `${threadId}-plan`,
        turnId: TURN_ID,
        planMarkdown: "Plan",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    latestProposedPlanSummary: {
      id: `${threadId}-plan`,
      turnId: TURN_ID,
      implementedAt: null,
      implementationThreadId: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    queuedComposerMessages: [],
    queuedSteerRequest: null,
    activities: [
      {
        id: EventId.makeUnsafe(`${threadId}-approval-requested`),
        tone: "approval" as const,
        kind: "approval.requested",
        summary: "Needs approval",
        payload: {},
        turnId: TURN_ID,
        createdAt: NOW,
      },
      {
        id: EventId.makeUnsafe(`${threadId}-tool-progress`),
        tone: "info" as const,
        kind: "tool.progress",
        summary: "Tool progress",
        payload: {},
        turnId: TURN_ID,
        createdAt: NOW,
      },
    ],
    checkpoints: [
      {
        turnId: TURN_ID,
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe(`${threadId}-checkpoint`),
        status: "ready" as const,
        source: "git-checkpoint" as const,
        files: [],
        assistantMessageId: MessageId.makeUnsafe(`${threadId}-assistant-message`),
        completedAt: NOW,
      },
    ],
    session: null,
    ...overrides,
  };
}

function makeReadModel(): OrchestrationReadModel {
  return {
    snapshotSequence: 7,
    updatedAt: NOW,
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    threads: [makeThread(THREAD_ONE_ID), makeThread(THREAD_TWO_ID)],
  };
}

describe("createReadModelSnapshotView", () => {
  it("returns a metadata-only read model when thread hydration mode is not requested", () => {
    const readModel = makeReadModel();

    const snapshot = createReadModelSnapshotView(readModel);
    const emptyInputSnapshot = createReadModelSnapshotView(readModel, {});

    expect(snapshot).not.toBe(readModel);
    expect(emptyInputSnapshot).toEqual(snapshot);
    for (const thread of snapshot.threads) {
      expect(thread.messages).toEqual([]);
      expect(thread.activities).toEqual([]);
      expect(thread.checkpoints).toEqual([]);
      expect(thread.proposedPlans).toEqual([]);
      expect(thread.latestProposedPlanSummary?.id).toBe(`${thread.id}-plan`);
    }
  });

  it("returns metadata-only threads when hydrateThreadId is null", () => {
    const readModel = makeReadModel();

    const snapshot = createReadModelSnapshotView(readModel, {
      hydrateThreadId: null,
    });

    expect(snapshot).not.toBe(readModel);
    expect(snapshot.threads).toHaveLength(2);
    for (const thread of snapshot.threads) {
      expect(thread.messages).toEqual([]);
      expect(thread.activities).toEqual([]);
      expect(thread.checkpoints).toEqual([]);
      expect(thread.proposedPlans).toEqual([]);
      expect(thread.latestProposedPlanSummary?.id).toBe(`${thread.id}-plan`);
    }
  });

  it("drops transcript messages instead of keeping a partial fallback", () => {
    const readModel = makeReadModel();
    const snapshot = createReadModelSnapshotView(
      {
        ...readModel,
        threads: [
          makeThread(THREAD_ONE_ID, {
            messages: [
              {
                id: MessageId.makeUnsafe("thread-1-user-old"),
                role: "user",
                text: "Old user message",
                turnId: TURN_ID,
                streaming: false,
                createdAt: "2026-04-05T00:00:00.000Z",
                updatedAt: "2026-04-05T00:00:00.000Z",
              },
              {
                id: MessageId.makeUnsafe("thread-1-assistant"),
                role: "assistant",
                text: "Assistant message",
                turnId: TURN_ID,
                streaming: false,
                createdAt: "2026-04-05T00:00:01.000Z",
                updatedAt: "2026-04-05T00:00:01.000Z",
              },
              {
                id: MessageId.makeUnsafe("thread-1-user-latest"),
                role: "user",
                text: "Latest user message",
                turnId: TURN_ID,
                streaming: false,
                createdAt: "2026-04-05T00:00:02.000Z",
                updatedAt: "2026-04-05T00:00:02.000Z",
              },
            ],
          }),
        ],
      },
      {
        hydrateThreadId: null,
      },
    );

    expect(snapshot.threads[0]?.messages).toEqual([]);
  });

  it("ignores requested thread hydration and returns one metadata snapshot shape", () => {
    const readModel = makeReadModel();

    const snapshot = createReadModelSnapshotView(readModel, {
      hydrateThreadId: THREAD_ONE_ID,
    });

    for (const thread of snapshot.threads) {
      expect(thread.messages).toEqual([]);
      expect(thread.activities).toEqual([]);
      expect(thread.checkpoints).toEqual([]);
      expect(thread.proposedPlans).toEqual([]);
      expect(thread.latestProposedPlanSummary?.id).toBe(`${thread.id}-plan`);
    }
  });

  it("drops activity rows instead of bounding a partial activity summary", () => {
    const manyActivities = Array.from({ length: 40 }, (_, index) => ({
      id: EventId.makeUnsafe(`thread-2-activity-${index + 1}`),
      tone: "info" as const,
      kind: "tool.progress",
      summary: `Activity ${index + 1}`,
      payload: {},
      turnId: TURN_ID,
      createdAt: `2026-04-05T00:00:${String(index).padStart(2, "0")}.000Z`,
      sequence: index + 1,
    }));
    const readModel = makeReadModel();
    const threadOneActivities = readModel.threads[0]?.activities ?? [];
    const snapshot = createReadModelSnapshotView(
      {
        ...readModel,
        threads: [
          makeThread(THREAD_ONE_ID, { activities: threadOneActivities }),
          makeThread(THREAD_TWO_ID, { activities: manyActivities }),
        ],
      },
      {
        hydrateThreadId: THREAD_ONE_ID,
      },
    );

    expect(snapshot.threads.find((thread) => thread.id === THREAD_ONE_ID)?.activities).toEqual([]);
    expect(snapshot.threads.find((thread) => thread.id === THREAD_TWO_ID)?.activities).toEqual([]);
  });
});
