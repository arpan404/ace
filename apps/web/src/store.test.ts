import {
  CheckpointRef,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@ace/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  applyOrchestrationEvent,
  applyOrchestrationEvents,
  dismissThreadError,
  hydrateThreadFromReadModel,
  pruneHydratedThreadHistories,
  syncServerReadModel,
  type AppState,
} from "./store";
import {
  __resetThreadHydrationCacheForTests,
  readCachedHydratedThread,
} from "./lib/threadHydrationCache";
import { getChatMessageFullText } from "./lib/chat/messageText";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";

beforeEach(() => {
  __resetThreadHydrationCacheForTests();
});

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    latestProposedPlanSummary: null,
    error: null,
    createdAt: "2026-02-13T00:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    queuedComposerMessages: [],
    queuedSteerRequest: null,
    ...overrides,
    kind: overrides.kind ?? "coding",
  };
}

function makeState(thread: Thread): AppState {
  const threadIdsByProjectId: AppState["threadIdsByProjectId"] = {
    [thread.projectId]: [thread.id],
  };
  return {
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        name: "Project",
        cwd: "/tmp/project",
        icon: null,
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        archivedAt: null,
        scripts: [],
      },
    ],
    threads: [thread],
    sidebarThreadsById: {},
    threadIdsByProjectId,
    dismissedThreadErrorKeysById: {},
    bootstrapComplete: true,
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
    occurredAt: "2026-02-27T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload,
    ...overrides,
  } as Extract<OrchestrationEvent, { type: T }>;
}

function makeReadModelThread(overrides: Partial<OrchestrationReadModel["threads"][number]>) {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.3-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: [],
    activities: [],
    proposedPlans: [],
    latestProposedPlanSummary: null,
    queuedComposerMessages: [],
    queuedSteerRequest: null,
    checkpoints: [],
    session: null,
    ...overrides,
    kind: overrides.kind ?? "coding",
  } satisfies OrchestrationReadModel["threads"][number];
}

function makeReadModel(thread: OrchestrationReadModel["threads"][number]): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: "2026-02-27T00:00:00.000Z",
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project",
        icon: null,
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
        },
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
        archivedAt: null,
        deletedAt: null,
        scripts: [],
      },
    ],
    threads: [thread],
  };
}

function makeReadModelFromThreads(
  threads: ReadonlyArray<OrchestrationReadModel["threads"][number]>,
): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: "2026-02-27T00:00:00.000Z",
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project",
        icon: null,
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
        },
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
        archivedAt: null,
        deletedAt: null,
        scripts: [],
      },
    ],
    threads: [...threads],
  };
}

function makeReadModelProject(
  overrides: Partial<OrchestrationReadModel["projects"][number]>,
): OrchestrationReadModel["projects"][number] {
  return {
    id: ProjectId.makeUnsafe("project-1"),
    title: "Project",
    workspaceRoot: "/tmp/project",
    icon: null,
    defaultModelSelection: {
      provider: "codex",
      model: "gpt-5.3-codex",
    },
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    scripts: [],
    ...overrides,
  };
}

describe("store read model sync", () => {
  it("marks bootstrap complete after snapshot sync", () => {
    const initialState: AppState = {
      ...makeState(makeThread()),
      bootstrapComplete: false,
    };

    const next = syncServerReadModel(initialState, makeReadModel(makeReadModelThread({})));

    expect(next.bootstrapComplete).toBe(true);
  });

  it("preserves claude model slugs without an active session", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.modelSelection.model).toBe("claude-opus-4-6");
  });

  it("resolves claude aliases when session provider is claudeAgent", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        modelSelection: {
          provider: "claudeAgent",
          model: "sonnet",
        },
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.modelSelection.model).toBe("claude-sonnet-4-6");
  });

  it.each([
    ["gemini", "gemini-2.5-pro"],
    ["opencode", "auto"],
  ] as const)("preserves %s session providers from the read model", (providerName, model) => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        modelSelection: {
          provider: providerName,
          model,
        },
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName,
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.session?.provider).toBe(providerName);
    expect(next.threads[0]?.modelSelection.model).toBe(model);
  });

  it("preserves project and thread updatedAt timestamps from the read model", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        updatedAt: "2026-02-27T00:05:00.000Z",
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.projects[0]?.updatedAt).toBe("2026-02-27T00:00:00.000Z");
    expect(next.threads[0]?.updatedAt).toBe("2026-02-27T00:05:00.000Z");
  });

  it("maps archivedAt from the read model", () => {
    const initialState = makeState(makeThread());
    const archivedAt = "2026-02-28T00:00:00.000Z";
    const next = syncServerReadModel(
      initialState,
      makeReadModel(
        makeReadModelThread({
          archivedAt,
        }),
      ),
    );

    expect(next.threads[0]?.archivedAt).toBe(archivedAt);
  });

  it("maps attachment preview URLs to the snapshot connection host", () => {
    const initialState = makeState(makeThread());
    const next = syncServerReadModel(
      initialState,
      makeReadModel(
        makeReadModelThread({
          messages: [
            {
              id: MessageId.makeUnsafe("message-attachment"),
              role: "user",
              text: "See image",
              turnId: null,
              streaming: false,
              createdAt: "2026-02-27T00:00:00.000Z",
              updatedAt: "2026-02-27T00:00:00.000Z",
              attachments: [
                {
                  id: "attachment-1" as never,
                  name: "image.png",
                  type: "image",
                  mimeType: "image/png",
                  sizeBytes: 10,
                },
              ],
            },
          ],
        }),
      ),
      { connectionUrl: "wss://remote.example/ws?token=test-token" },
    );

    expect(next.threads[0]?.messages[0]?.attachments?.[0]?.previewUrl).toBe(
      "https://remote.example/attachments/attachment-1?token=test-token",
    );
  });

  it("maps queued composer state from the read model", () => {
    const initialState = makeState(makeThread());
    const next = syncServerReadModel(
      initialState,
      makeReadModel(
        makeReadModelThread({
          queuedComposerMessages: [
            {
              id: MessageId.makeUnsafe("queued-message-1"),
              prompt: "Follow up after the current run",
              images: [
                {
                  type: "image",
                  id: "queued-image-1" as never,
                  name: "diagram.png",
                  mimeType: "image/png",
                  sizeBytes: 12,
                  dataUrl: "data:image/png;base64,AA==",
                },
              ],
              terminalContexts: [],
              modelSelection: {
                provider: "codex",
                model: "gpt-5.3-codex",
              },
              runtimeMode: "full-access",
              interactionMode: "default",
            },
          ],
          queuedSteerRequest: {
            messageId: MessageId.makeUnsafe("queued-message-1"),
            baselineWorkLogEntryCount: 4,
            interruptRequested: false,
          },
        }),
      ),
    );

    expect(next.threads[0]?.queuedComposerMessages).toEqual([
      {
        id: MessageId.makeUnsafe("queued-message-1"),
        prompt: "Follow up after the current run",
        images: [
          {
            type: "image",
            id: "queued-image-1",
            name: "diagram.png",
            mimeType: "image/png",
            sizeBytes: 12,
            dataUrl: "data:image/png;base64,AA==",
            previewUrl: "data:image/png;base64,AA==",
          },
        ],
        terminalContexts: [],
        modelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
      },
    ]);
    expect(next.threads[0]?.queuedSteerRequest).toEqual({
      messageId: MessageId.makeUnsafe("queued-message-1"),
      baselineWorkLogEntryCount: 4,
      interruptRequested: false,
    });
  });

  it("marks only the requested thread as history-loaded during lean snapshot sync", () => {
    const initialState = makeState(makeThread());
    const firstThreadId = ThreadId.makeUnsafe("thread-1");
    const secondThreadId = ThreadId.makeUnsafe("thread-2");
    const readModel = makeReadModelFromThreads([
      makeReadModelThread({
        id: firstThreadId,
        messages: [
          {
            id: MessageId.makeUnsafe("message-1"),
            role: "user",
            text: "First",
            turnId: null,
            streaming: false,
            createdAt: "2026-02-27T00:00:00.000Z",
            updatedAt: "2026-02-27T00:00:00.000Z",
          },
        ],
      }),
      makeReadModelThread({
        id: secondThreadId,
        messages: [
          {
            id: MessageId.makeUnsafe("message-2"),
            role: "user",
            text: "Second",
            turnId: null,
            streaming: false,
            createdAt: "2026-02-27T00:01:00.000Z",
            updatedAt: "2026-02-27T00:01:00.000Z",
          },
        ],
      }),
    ]);

    const next = syncServerReadModel(initialState, readModel, {
      hydrateThreadId: firstThreadId,
    });

    expect(next.threads.find((thread) => thread.id === firstThreadId)?.historyLoaded).toBe(true);
    expect(next.threads.find((thread) => thread.id === secondThreadId)?.historyLoaded).toBe(false);
  });

  it("hydrates an individual thread from a later snapshot without replacing the rest of the store", () => {
    const targetThreadId = ThreadId.makeUnsafe("thread-1");
    const initialState = syncServerReadModel(
      makeState(makeThread({ id: targetThreadId })),
      makeReadModel(
        makeReadModelThread({
          id: targetThreadId,
          messages: [
            {
              id: MessageId.makeUnsafe("message-1"),
              role: "user",
              text: "Short summary",
              turnId: null,
              streaming: false,
              createdAt: "2026-02-27T00:00:00.000Z",
              updatedAt: "2026-02-27T00:00:00.000Z",
            },
          ],
        }),
      ),
      { hydrateThreadId: null },
    );

    const next = hydrateThreadFromReadModel(
      initialState,
      makeReadModelThread({
        id: targetThreadId,
        messages: [
          {
            id: MessageId.makeUnsafe("message-1"),
            role: "user",
            text: "Short summary",
            turnId: null,
            streaming: false,
            createdAt: "2026-02-27T00:00:00.000Z",
            updatedAt: "2026-02-27T00:00:00.000Z",
          },
          {
            id: MessageId.makeUnsafe("message-2"),
            role: "assistant",
            text: "Full thread body",
            turnId: null,
            streaming: false,
            createdAt: "2026-02-27T00:00:01.000Z",
            updatedAt: "2026-02-27T00:00:01.000Z",
          },
        ],
      }),
    );

    expect(next.threads[0]?.historyLoaded).toBe(true);
    expect(next.threads[0]?.messages.map((message) => message.id)).toEqual([
      MessageId.makeUnsafe("message-1"),
      MessageId.makeUnsafe("message-2"),
    ]);
    expect(
      readCachedHydratedThread(targetThreadId, "2026-02-27T00:00:00.000Z")?.messages,
    ).toHaveLength(2);
  });

  it("primes the shared hydration cache only for fully loaded snapshot threads", () => {
    const firstThreadId = ThreadId.makeUnsafe("thread-1");
    const secondThreadId = ThreadId.makeUnsafe("thread-2");
    const readModel = makeReadModelFromThreads([
      makeReadModelThread({
        id: firstThreadId,
        updatedAt: "2026-02-27T00:00:00.000Z",
        messages: [
          {
            id: MessageId.makeUnsafe("message-1"),
            role: "user",
            text: "Loaded",
            turnId: null,
            streaming: false,
            createdAt: "2026-02-27T00:00:00.000Z",
            updatedAt: "2026-02-27T00:00:00.000Z",
          },
        ],
      }),
      makeReadModelThread({
        id: secondThreadId,
        updatedAt: "2026-02-27T00:01:00.000Z",
        messages: [
          {
            id: MessageId.makeUnsafe("message-2"),
            role: "user",
            text: "Lean only",
            turnId: null,
            streaming: false,
            createdAt: "2026-02-27T00:01:00.000Z",
            updatedAt: "2026-02-27T00:01:00.000Z",
          },
        ],
      }),
    ]);

    syncServerReadModel(makeState(makeThread({ id: firstThreadId })), readModel, {
      hydrateThreadId: firstThreadId,
    });

    expect(
      readCachedHydratedThread(firstThreadId, "2026-02-27T00:00:00.000Z")?.messages,
    ).toHaveLength(1);
    expect(readCachedHydratedThread(secondThreadId, "2026-02-27T00:01:00.000Z")).toBeNull();
  });

  it("demotes inactive hydrated threads back to lean summaries", () => {
    const activeThreadId = ThreadId.makeUnsafe("thread-active");
    const completedThreadId = ThreadId.makeUnsafe("thread-completed");
    const runningThreadId = ThreadId.makeUnsafe("thread-running");
    const sharedProjectId = ProjectId.makeUnsafe("project-1");
    const completedTurnId = TurnId.makeUnsafe("turn-completed");
    const runningTurnId = TurnId.makeUnsafe("turn-running");
    const state: AppState = {
      projects: makeState(makeThread({ id: activeThreadId })).projects,
      threads: [
        makeThread({
          id: activeThreadId,
          projectId: sharedProjectId,
          historyLoaded: true,
          messages: [
            {
              id: MessageId.makeUnsafe("active-user"),
              role: "user",
              text: "Keep me loaded",
              turnId: null,
              streaming: false,
              createdAt: "2026-02-27T00:00:00.000Z",
            },
          ],
        }),
        makeThread({
          id: completedThreadId,
          projectId: sharedProjectId,
          historyLoaded: true,
          messages: [
            {
              id: MessageId.makeUnsafe("completed-user"),
              role: "user",
              text: "User summary",
              turnId: completedTurnId,
              streaming: false,
              createdAt: "2026-02-27T00:00:00.000Z",
            },
            {
              id: MessageId.makeUnsafe("completed-assistant"),
              role: "assistant",
              text: "Full assistant history",
              turnId: completedTurnId,
              streaming: false,
              createdAt: "2026-02-27T00:00:01.000Z",
            },
          ],
          proposedPlans: [
            {
              id: "plan-1",
              turnId: completedTurnId,
              planMarkdown: "# Plan",
              implementedAt: null,
              implementationThreadId: null,
              createdAt: "2026-02-27T00:00:01.000Z",
              updatedAt: "2026-02-27T00:00:02.000Z",
            },
          ],
          activities: [
            {
              id: EventId.makeUnsafe("approval-activity"),
              tone: "info",
              kind: "approval.requested",
              summary: "Need approval",
              payload: {},
              turnId: completedTurnId,
              createdAt: "2026-02-27T00:00:01.000Z",
            },
            {
              id: EventId.makeUnsafe("tool-activity"),
              tone: "tool",
              kind: "tool.completed",
              summary: "Ran tool",
              payload: {},
              turnId: completedTurnId,
              createdAt: "2026-02-27T00:00:02.000Z",
            },
          ],
          turnDiffSummaries: [
            {
              turnId: completedTurnId,
              completedAt: "2026-02-27T00:00:03.000Z",
              status: "ready",
              source: "git-checkpoint",
              files: [],
              checkpointTurnCount: 1,
            },
          ],
          latestTurn: {
            turnId: completedTurnId,
            state: "completed",
            requestedAt: "2026-02-27T00:00:00.000Z",
            startedAt: "2026-02-27T00:00:00.000Z",
            completedAt: "2026-02-27T00:00:03.000Z",
            assistantMessageId: MessageId.makeUnsafe("completed-assistant"),
          },
        }),
        makeThread({
          id: runningThreadId,
          projectId: sharedProjectId,
          historyLoaded: true,
          messages: [
            {
              id: MessageId.makeUnsafe("running-user"),
              role: "user",
              text: "Still running",
              turnId: runningTurnId,
              streaming: false,
              createdAt: "2026-02-27T00:00:04.000Z",
            },
            {
              id: MessageId.makeUnsafe("running-assistant"),
              role: "assistant",
              text: "Streaming",
              turnId: runningTurnId,
              streaming: true,
              createdAt: "2026-02-27T00:00:05.000Z",
            },
          ],
          latestTurn: {
            turnId: runningTurnId,
            state: "running",
            requestedAt: "2026-02-27T00:00:04.000Z",
            startedAt: "2026-02-27T00:00:04.000Z",
            completedAt: null,
            assistantMessageId: MessageId.makeUnsafe("running-assistant"),
          },
          session: {
            provider: "codex",
            status: "running",
            orchestrationStatus: "running",
            activeTurnId: runningTurnId,
            createdAt: "2026-02-27T00:00:04.000Z",
            updatedAt: "2026-02-27T00:00:05.000Z",
          },
        }),
      ],
      sidebarThreadsById: {},
      threadIdsByProjectId: {
        [sharedProjectId]: [activeThreadId, completedThreadId, runningThreadId],
      },
      dismissedThreadErrorKeysById: {},
      bootstrapComplete: true,
    };

    const next = pruneHydratedThreadHistories(state, [activeThreadId]);
    const completedThread = next.threads.find((thread) => thread.id === completedThreadId);
    const runningThread = next.threads.find((thread) => thread.id === runningThreadId);

    expect(completedThread?.historyLoaded).toBe(false);
    expect(completedThread?.messages.map((message) => message.role)).toEqual(["user"]);
    expect(completedThread?.proposedPlans).toEqual([]);
    expect(completedThread?.latestProposedPlanSummary?.id).toBe("plan-1");
    expect(completedThread?.turnDiffSummaries).toEqual([]);
    expect(completedThread?.activities.map((activity) => activity.kind)).toEqual([
      "approval.requested",
    ]);
    expect(runningThread?.historyLoaded).toBe(true);
    expect(runningThread?.messages).toHaveLength(2);
  });

  it("derives sidebar proposed-plan state from latestProposedPlanSummary for lean threads", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const initialState = makeState(makeThread({ id: threadId }));
    const readModel = makeReadModel(
      makeReadModelThread({
        id: threadId,
        interactionMode: "plan",
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: "2026-02-27T00:00:01.000Z",
          assistantMessageId: MessageId.makeUnsafe("message-1"),
        },
        proposedPlans: [],
        latestProposedPlanSummary: {
          id: "plan-1",
          turnId: TurnId.makeUnsafe("turn-1"),
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:01.000Z",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel, {
      hydrateThreadId: null,
    });

    expect(next.threads[0]?.historyLoaded).toBe(false);
    expect(next.threads[0]?.proposedPlans).toEqual([]);
    expect(next.sidebarThreadsById[threadId]?.hasActionableProposedPlan).toBe(true);
  });

  it("replaces projects using snapshot order during recovery", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const project3 = ProjectId.makeUnsafe("project-3");
    const initialState: AppState = {
      projects: [
        {
          id: project2,
          name: "Project 2",
          cwd: "/tmp/project-2",
          icon: null,
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          archivedAt: null,
          scripts: [],
        },
        {
          id: project1,
          name: "Project 1",
          cwd: "/tmp/project-1",
          icon: null,
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          archivedAt: null,
          scripts: [],
        },
      ],
      threads: [],
      sidebarThreadsById: {},
      threadIdsByProjectId: {},
      dismissedThreadErrorKeysById: {},
      bootstrapComplete: true,
    };
    const readModel: OrchestrationReadModel = {
      snapshotSequence: 2,
      updatedAt: "2026-02-27T00:00:00.000Z",
      projects: [
        makeReadModelProject({
          id: project1,
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
        }),
        makeReadModelProject({
          id: project2,
          title: "Project 2",
          workspaceRoot: "/tmp/project-2",
        }),
        makeReadModelProject({
          id: project3,
          title: "Project 3",
          workspaceRoot: "/tmp/project-3",
        }),
      ],
      threads: [],
    };

    const next = syncServerReadModel(initialState, readModel);

    expect(next.projects.map((project) => project.id)).toEqual([project1, project2, project3]);
  });
});

describe("incremental orchestration updates", () => {
  it("does not mark bootstrap complete for incremental events", () => {
    const state: AppState = {
      ...makeState(makeThread()),
      bootstrapComplete: false,
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.meta-updated", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: "Updated title",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.bootstrapComplete).toBe(false);
  });

  it("preserves state identity for no-op project and thread deletes", () => {
    const thread = makeThread();
    const state = makeState(thread);

    const nextAfterProjectDelete = applyOrchestrationEvent(
      state,
      makeEvent("project.deleted", {
        projectId: ProjectId.makeUnsafe("project-missing"),
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
    );
    const nextAfterThreadDelete = applyOrchestrationEvent(
      state,
      makeEvent("thread.deleted", {
        threadId: ThreadId.makeUnsafe("thread-missing"),
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(nextAfterProjectDelete).toBe(state);
    expect(nextAfterThreadDelete).toBe(state);
  });

  it("reuses an existing project row when project.created arrives with a new id for the same cwd", () => {
    const originalProjectId = ProjectId.makeUnsafe("project-1");
    const recreatedProjectId = ProjectId.makeUnsafe("project-2");
    const state: AppState = {
      projects: [
        {
          id: originalProjectId,
          name: "Project",
          cwd: "/tmp/project",
          icon: null,
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          archivedAt: null,
          scripts: [],
        },
      ],
      threads: [],
      sidebarThreadsById: {},
      threadIdsByProjectId: {},
      dismissedThreadErrorKeysById: {},
      bootstrapComplete: true,
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("project.created", {
        projectId: recreatedProjectId,
        title: "Project Recreated",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: {
          provider: "codex",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
        },
        scripts: [],
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.projects).toHaveLength(1);
    expect(next.projects[0]?.id).toBe(recreatedProjectId);
    expect(next.projects[0]?.cwd).toBe("/tmp/project");
    expect(next.projects[0]?.name).toBe("Project Recreated");
  });

  it("removes stale project index entries when thread.created recreates a thread under a new project", () => {
    const originalProjectId = ProjectId.makeUnsafe("project-1");
    const recreatedProjectId = ProjectId.makeUnsafe("project-2");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const thread = makeThread({
      id: threadId,
      projectId: originalProjectId,
    });
    const state: AppState = {
      projects: [
        {
          id: originalProjectId,
          name: "Project 1",
          cwd: "/tmp/project-1",
          icon: null,
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          archivedAt: null,
          scripts: [],
        },
        {
          id: recreatedProjectId,
          name: "Project 2",
          cwd: "/tmp/project-2",
          icon: null,
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          archivedAt: null,
          scripts: [],
        },
      ],
      threads: [thread],
      sidebarThreadsById: {},
      threadIdsByProjectId: {
        [originalProjectId]: [threadId],
      },
      dismissedThreadErrorKeysById: {},
      bootstrapComplete: true,
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.created", {
        threadId,
        projectId: recreatedProjectId,
        kind: "coding",
        title: "Recovered thread",
        modelSelection: {
          provider: "codex",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
        },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.threads).toHaveLength(1);
    expect(next.threads[0]?.projectId).toBe(recreatedProjectId);
    expect(next.threadIdsByProjectId[originalProjectId]).toBeUndefined();
    expect(next.threadIdsByProjectId[recreatedProjectId]).toEqual([threadId]);
  });

  it("retains handoff metadata from thread.created events", () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const threadId = ThreadId.makeUnsafe("thread-handoff");
    const sourceThreadId = ThreadId.makeUnsafe("thread-source");
    const state: AppState = {
      projects: [
        {
          id: projectId,
          name: "Project 1",
          cwd: "/tmp/project-1",
          icon: null,
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          archivedAt: null,
          scripts: [],
        },
      ],
      threads: [],
      sidebarThreadsById: {},
      threadIdsByProjectId: {},
      dismissedThreadErrorKeysById: {},
      bootstrapComplete: true,
    };

    const handoff = {
      sourceThreadId,
      fromProvider: "codex" as const,
      toProvider: "claudeAgent" as const,
      mode: "transcript" as const,
      createdAt: "2026-02-27T00:00:01.000Z",
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.created", {
        threadId,
        projectId,
        kind: "coding",
        title: "Handoff thread",
        modelSelection: {
          provider: "claudeAgent",
          model: DEFAULT_MODEL_BY_PROVIDER.claudeAgent,
        },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        handoff,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.threads[0]?.handoff).toEqual(handoff);
    expect(next.sidebarThreadsById[threadId]?.handoff).toEqual(handoff);
  });

  it("updates only the affected thread for message events", () => {
    const thread1 = makeThread({
      id: ThreadId.makeUnsafe("thread-1"),
      messages: [
        {
          id: MessageId.makeUnsafe("message-1"),
          role: "assistant",
          text: "hello",
          turnId: TurnId.makeUnsafe("turn-1"),
          createdAt: "2026-02-27T00:00:00.000Z",
          completedAt: "2026-02-27T00:00:00.000Z",
          streaming: false,
        },
      ],
    });
    const thread2 = makeThread({ id: ThreadId.makeUnsafe("thread-2") });
    const state: AppState = {
      ...makeState(thread1),
      threads: [thread1, thread2],
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId: thread1.id,
        messageId: MessageId.makeUnsafe("message-1"),
        role: "assistant",
        text: " world",
        turnId: TurnId.makeUnsafe("turn-1"),
        streaming: true,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(getChatMessageFullText(next.threads[0]?.messages[0] ?? { text: "" })).toBe(
      "hello world",
    );
    expect(next.threads[0]?.latestTurn?.state).toBe("running");
    expect(next.threads[1]).toBe(thread2);
  });

  it("preserves streamed assistant content when completion carries only trailing text", () => {
    const threadId = ThreadId.makeUnsafe("thread-streamed-completion");
    const messageId = MessageId.makeUnsafe("message-streamed-completion");
    const turnId = TurnId.makeUnsafe("turn-streamed-completion");
    const state = makeState(
      makeThread({
        id: threadId,
        messages: [
          {
            id: messageId,
            role: "assistant",
            text: "hello",
            turnId,
            createdAt: "2026-02-27T00:00:00.000Z",
            completedAt: "2026-02-27T00:00:00.000Z",
            streaming: false,
          },
        ],
      }),
    );

    const streaming = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId,
        messageId,
        role: "assistant",
        text: " world",
        turnId,
        streaming: true,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    const next = applyOrchestrationEvent(
      streaming,
      makeEvent("thread.message-sent", {
        threadId,
        messageId,
        role: "assistant",
        text: "!",
        turnId,
        streaming: false,
        createdAt: "2026-02-27T00:00:02.000Z",
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
    );

    expect(next.threads[0]?.messages[0]?.text).toBe("hello world!");
    expect(next.threads[0]?.messages[0]?.streaming).toBe(false);
  });

  it("prefers payload sequence for assistant messages when provided", () => {
    const thread = makeThread();
    const state = makeState(thread);

    const next = applyOrchestrationEvent(
      state,
      makeEvent(
        "thread.message-sent",
        {
          threadId: thread.id,
          messageId: MessageId.makeUnsafe("assistant-sequenced"),
          role: "assistant",
          text: "sequenced",
          turnId: TurnId.makeUnsafe("turn-1"),
          streaming: false,
          sequence: 1_706_255_202_000_001,
          createdAt: "2026-02-27T00:00:01.000Z",
          updatedAt: "2026-02-27T00:00:01.000Z",
        },
        { sequence: 3 },
      ),
    );

    expect(next.threads[0]?.messages[0]?.sequence).toBe(1_706_255_202_000_001);
  });

  it("keeps lean thread plan bodies unloaded while refreshing the latest plan summary", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-1"),
        state: "completed",
        requestedAt: "2026-02-27T00:00:00.000Z",
        startedAt: "2026-02-27T00:00:00.000Z",
        completedAt: "2026-02-27T00:00:01.000Z",
        assistantMessageId: MessageId.makeUnsafe("message-1"),
      },
      historyLoaded: false,
    });
    const state = makeState(thread);

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.proposed-plan-upserted", {
        threadId: thread.id,
        proposedPlan: {
          id: "plan-1",
          turnId: TurnId.makeUnsafe("turn-1"),
          planMarkdown: "# Plan",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:01.000Z",
        },
      }),
    );

    expect(next.threads[0]?.proposedPlans).toEqual([]);
    expect(next.threads[0]?.latestProposedPlanSummary).toEqual({
      id: "plan-1",
      turnId: TurnId.makeUnsafe("turn-1"),
      implementedAt: null,
      implementationThreadId: null,
      createdAt: "2026-02-27T00:00:00.000Z",
      updatedAt: "2026-02-27T00:00:01.000Z",
    });
    expect(next.sidebarThreadsById[thread.id]?.hasActionableProposedPlan).toBe(true);
  });

  it("keeps lean threads from regrowing full history from background events", () => {
    const thread = makeThread({
      historyLoaded: false,
      messages: [
        {
          id: MessageId.makeUnsafe("user-message"),
          role: "user",
          text: "Existing summary",
          turnId: TurnId.makeUnsafe("turn-1"),
          streaming: false,
          createdAt: "2026-02-27T00:00:00.000Z",
        },
      ],
    });
    const state = makeState(thread);

    const next = applyOrchestrationEvents(state, [
      makeEvent("thread.message-sent", {
        threadId: thread.id,
        messageId: MessageId.makeUnsafe("assistant-message"),
        role: "assistant",
        text: "Assistant body",
        turnId: TurnId.makeUnsafe("turn-1"),
        streaming: false,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
      makeEvent("thread.turn-diff-completed", {
        threadId: thread.id,
        turnId: TurnId.makeUnsafe("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
        status: "ready",
        source: "git-checkpoint",
        files: [],
        assistantMessageId: MessageId.makeUnsafe("assistant-message"),
        completedAt: "2026-02-27T00:00:03.000Z",
      }),
      makeEvent("thread.activity-appended", {
        threadId: thread.id,
        activity: {
          id: EventId.makeUnsafe("tool-activity"),
          tone: "tool",
          kind: "tool.started",
          summary: "Tool started",
          payload: {},
          turnId: TurnId.makeUnsafe("turn-1"),
          createdAt: "2026-02-27T00:00:04.000Z",
        },
      }),
      makeEvent("thread.activity-appended", {
        threadId: thread.id,
        activity: {
          id: EventId.makeUnsafe("approval-activity"),
          tone: "info",
          kind: "approval.requested",
          summary: "Approval needed",
          payload: {},
          turnId: TurnId.makeUnsafe("turn-1"),
          createdAt: "2026-02-27T00:00:05.000Z",
        },
      }),
    ]);

    expect(next.threads[0]?.messages.map((message) => message.id)).toEqual([
      MessageId.makeUnsafe("user-message"),
    ]);
    expect(next.threads[0]?.turnDiffSummaries).toEqual([]);
    expect(next.threads[0]?.activities.map((activity) => activity.kind)).toEqual([
      "approval.requested",
    ]);
    expect(next.threads[0]?.latestTurn?.state).toBe("completed");
  });

  it("orders appended activities by createdAt when legacy entries are missing sequence", () => {
    const thread = makeThread({
      activities: [
        {
          id: EventId.makeUnsafe("legacy-activity"),
          tone: "tool",
          kind: "tool.completed",
          summary: "Legacy activity",
          payload: {},
          turnId: null,
          createdAt: "2026-02-27T00:00:02.000Z",
        },
      ],
    });
    const state = makeState(thread);

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.activity-appended", {
        threadId: thread.id,
        activity: {
          id: EventId.makeUnsafe("sequenced-activity"),
          tone: "tool",
          kind: "tool.started",
          summary: "Sequenced activity",
          payload: {},
          turnId: null,
          sequence: 1,
          createdAt: "2026-02-27T00:00:01.000Z",
        },
      }),
    );

    expect(next.threads[0]?.activities.map((activity) => activity.id)).toEqual([
      "sequenced-activity",
      "legacy-activity",
    ]);
  });

  it("applies replay batches in sequence and updates session state", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-1"),
        state: "running",
        requestedAt: "2026-02-27T00:00:00.000Z",
        startedAt: "2026-02-27T00:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const state = makeState(thread);

    const next = applyOrchestrationEvents(state, [
      makeEvent(
        "thread.session-set",
        {
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.makeUnsafe("turn-1"),
            lastError: null,
            updatedAt: "2026-02-27T00:00:02.000Z",
          },
        },
        { sequence: 2 },
      ),
      makeEvent(
        "thread.message-sent",
        {
          threadId: thread.id,
          messageId: MessageId.makeUnsafe("assistant-1"),
          role: "assistant",
          text: "done",
          turnId: TurnId.makeUnsafe("turn-1"),
          streaming: false,
          createdAt: "2026-02-27T00:00:03.000Z",
          updatedAt: "2026-02-27T00:00:03.000Z",
        },
        { sequence: 3 },
      ),
    ]);

    expect(next.threads[0]?.session?.status).toBe("running");
    expect(next.threads[0]?.latestTurn?.state).toBe("completed");
    expect(next.threads[0]?.messages).toHaveLength(1);
  });

  it("marks running latestTurn completed when session becomes ready", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-1"),
        state: "running",
        requestedAt: "2026-02-27T00:00:00.000Z",
        startedAt: "2026-02-27T00:00:01.000Z",
        completedAt: null,
        assistantMessageId: MessageId.makeUnsafe("assistant-1"),
      },
      session: {
        provider: "codex",
        status: "running",
        orchestrationStatus: "running",
        activeTurnId: TurnId.makeUnsafe("turn-1"),
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      },
    });
    const state = makeState(thread);

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.session-set", {
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-02-27T00:00:03.000Z",
        },
      }),
    );

    expect(next.threads[0]?.session?.status).toBe("ready");
    expect(next.threads[0]?.latestTurn?.state).toBe("completed");
    expect(next.threads[0]?.latestTurn?.completedAt).toBe("2026-02-27T00:00:03.000Z");
  });

  it("does not expose a stale session error while a retry is running", () => {
    const thread = makeThread();
    const state = makeState(thread);

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.session-set", {
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: TurnId.makeUnsafe("turn-retry"),
          lastError: "Selected model is at capacity.",
          updatedAt: "2026-02-27T00:00:03.000Z",
        },
      }),
    );

    expect(next.threads[0]?.session?.status).toBe("running");
    expect(next.threads[0]?.session?.lastError).toBe("Selected model is at capacity.");
    expect(next.threads[0]?.error).toBeNull();
  });

  it("keeps a dismissed session error hidden across repeated snapshots", () => {
    const thread = makeThread();
    const stateWithError = applyOrchestrationEvent(
      makeState(thread),
      makeEvent("thread.session-set", {
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "error",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "Selected model is at capacity.",
          updatedAt: "2026-02-27T00:00:03.000Z",
        },
      }),
    );

    const dismissed = dismissThreadError(stateWithError, thread.id);
    const snapshot = makeReadModel(
      makeReadModelThread({
        session: {
          threadId: thread.id,
          status: "error",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "Selected model is at capacity.",
          updatedAt: "2026-02-27T00:00:03.000Z",
        },
      }),
    );
    const synced = syncServerReadModel(dismissed, snapshot);

    expect(dismissed.threads[0]?.error).toBeNull();
    expect(dismissed.sidebarThreadsById[thread.id]?.isErrorDismissed).toBe(true);
    expect(synced.threads[0]?.error).toBeNull();
    expect(synced.sidebarThreadsById[thread.id]?.isErrorDismissed).toBe(true);
  });

  it("shows the same session error text again when it belongs to a newer failure", () => {
    const thread = makeThread();
    const stateWithError = applyOrchestrationEvent(
      makeState(thread),
      makeEvent("thread.session-set", {
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "error",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "Selected model is at capacity.",
          updatedAt: "2026-02-27T00:00:03.000Z",
        },
      }),
    );
    const dismissed = dismissThreadError(stateWithError, thread.id);

    const next = applyOrchestrationEvent(
      dismissed,
      makeEvent("thread.session-set", {
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "error",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "Selected model is at capacity.",
          updatedAt: "2026-02-27T00:05:00.000Z",
        },
      }),
    );

    expect(next.threads[0]?.error).toBe("Selected model is at capacity.");
  });

  it("does not regress latestTurn when an older turn diff completes late", () => {
    const state = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-2"),
          state: "running",
          requestedAt: "2026-02-27T00:00:02.000Z",
          startedAt: "2026-02-27T00:00:03.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.turn-diff-completed", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: TurnId.makeUnsafe("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
        status: "ready",
        source: "git-checkpoint",
        files: [],
        assistantMessageId: MessageId.makeUnsafe("assistant-1"),
        completedAt: "2026-02-27T00:00:04.000Z",
      }),
    );

    expect(next.threads[0]?.turnDiffSummaries).toHaveLength(1);
    expect(next.threads[0]?.latestTurn).toEqual(state.threads[0]?.latestTurn);
  });

  it("rebinds live turn diffs to the authoritative assistant message when it arrives later", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    const state = makeState(
      makeThread({
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: "2026-02-27T00:00:02.000Z",
          assistantMessageId: MessageId.makeUnsafe("assistant:turn-1"),
        },
        turnDiffSummaries: [
          {
            turnId,
            completedAt: "2026-02-27T00:00:02.000Z",
            status: "ready",
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
            assistantMessageId: MessageId.makeUnsafe("assistant:turn-1"),
            files: [{ path: "src/app.ts", additions: 1, deletions: 0 }],
          },
        ],
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("assistant-real"),
        role: "assistant",
        text: "final answer",
        turnId,
        streaming: false,
        createdAt: "2026-02-27T00:00:03.000Z",
        updatedAt: "2026-02-27T00:00:03.000Z",
      }),
    );

    expect(next.threads[0]?.turnDiffSummaries[0]?.assistantMessageId).toBe(
      MessageId.makeUnsafe("assistant-real"),
    );
    expect(next.threads[0]?.latestTurn?.assistantMessageId).toBe(
      MessageId.makeUnsafe("assistant-real"),
    );
  });

  it("reverts messages, plans, activities, and checkpoints by retained turns", () => {
    const state = makeState(
      makeThread({
        messages: [
          {
            id: MessageId.makeUnsafe("user-1"),
            role: "user",
            text: "first",
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-02-27T00:00:00.000Z",
            completedAt: "2026-02-27T00:00:00.000Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("assistant-1"),
            role: "assistant",
            text: "first reply",
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-02-27T00:00:01.000Z",
            completedAt: "2026-02-27T00:00:01.000Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("user-2"),
            role: "user",
            text: "second",
            turnId: TurnId.makeUnsafe("turn-2"),
            createdAt: "2026-02-27T00:00:02.000Z",
            completedAt: "2026-02-27T00:00:02.000Z",
            streaming: false,
          },
        ],
        proposedPlans: [
          {
            id: "plan-1",
            turnId: TurnId.makeUnsafe("turn-1"),
            planMarkdown: "plan 1",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-27T00:00:00.000Z",
            updatedAt: "2026-02-27T00:00:00.000Z",
          },
          {
            id: "plan-2",
            turnId: TurnId.makeUnsafe("turn-2"),
            planMarkdown: "plan 2",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-27T00:00:02.000Z",
            updatedAt: "2026-02-27T00:00:02.000Z",
          },
        ],
        activities: [
          {
            id: EventId.makeUnsafe("activity-1"),
            tone: "info",
            kind: "step",
            summary: "one",
            payload: {},
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-02-27T00:00:00.000Z",
          },
          {
            id: EventId.makeUnsafe("activity-2"),
            tone: "info",
            kind: "step",
            summary: "two",
            payload: {},
            turnId: TurnId.makeUnsafe("turn-2"),
            createdAt: "2026-02-27T00:00:02.000Z",
          },
        ],
        turnDiffSummaries: [
          {
            turnId: TurnId.makeUnsafe("turn-1"),
            completedAt: "2026-02-27T00:00:01.000Z",
            status: "ready",
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.makeUnsafe("ref-1"),
            files: [],
          },
          {
            turnId: TurnId.makeUnsafe("turn-2"),
            completedAt: "2026-02-27T00:00:03.000Z",
            status: "ready",
            checkpointTurnCount: 2,
            checkpointRef: CheckpointRef.makeUnsafe("ref-2"),
            files: [],
          },
        ],
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.reverted", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
      }),
    );

    expect(next.threads[0]?.messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
    ]);
    expect(next.threads[0]?.proposedPlans.map((plan) => plan.id)).toEqual(["plan-1"]);
    expect(next.threads[0]?.activities.map((activity) => activity.id)).toEqual([
      EventId.makeUnsafe("activity-1"),
    ]);
    expect(next.threads[0]?.turnDiffSummaries.map((summary) => summary.turnId)).toEqual([
      TurnId.makeUnsafe("turn-1"),
    ]);
  });

  it("clears pending source proposed plans after revert before a new session-set event", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-2"),
        state: "completed",
        requestedAt: "2026-02-27T00:00:02.000Z",
        startedAt: "2026-02-27T00:00:02.000Z",
        completedAt: "2026-02-27T00:00:03.000Z",
        assistantMessageId: MessageId.makeUnsafe("assistant-2"),
        sourceProposedPlan: {
          threadId: ThreadId.makeUnsafe("thread-source"),
          planId: "plan-2" as never,
        },
      },
      pendingSourceProposedPlan: {
        threadId: ThreadId.makeUnsafe("thread-source"),
        planId: "plan-2" as never,
      },
      turnDiffSummaries: [
        {
          turnId: TurnId.makeUnsafe("turn-1"),
          completedAt: "2026-02-27T00:00:01.000Z",
          status: "ready",
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.makeUnsafe("ref-1"),
          files: [],
        },
        {
          turnId: TurnId.makeUnsafe("turn-2"),
          completedAt: "2026-02-27T00:00:03.000Z",
          status: "ready",
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.makeUnsafe("ref-2"),
          files: [],
        },
      ],
    });
    const reverted = applyOrchestrationEvent(
      makeState(thread),
      makeEvent("thread.reverted", {
        threadId: thread.id,
        turnCount: 1,
      }),
    );

    expect(reverted.threads[0]?.pendingSourceProposedPlan).toBeUndefined();

    const next = applyOrchestrationEvent(
      reverted,
      makeEvent("thread.session-set", {
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: TurnId.makeUnsafe("turn-3"),
          lastError: null,
          updatedAt: "2026-02-27T00:00:04.000Z",
        },
      }),
    );

    expect(next.threads[0]?.latestTurn).toMatchObject({
      turnId: TurnId.makeUnsafe("turn-3"),
      state: "running",
    });
    expect(next.threads[0]?.latestTurn?.sourceProposedPlan).toBeUndefined();
  });

  it("compacts repeated reasoning activity so verbose turns keep earlier tool history visible", () => {
    const thread = makeThread();
    let state = makeState(thread);

    state = applyOrchestrationEvent(
      state,
      makeEvent("thread.activity-appended", {
        threadId: thread.id,
        activity: {
          id: EventId.makeUnsafe("tool-history"),
          tone: "tool",
          kind: "tool.completed",
          summary: "Read file",
          payload: { detail: "packages/contracts/src/model.ts" },
          turnId: TurnId.makeUnsafe("turn-1"),
          createdAt: "2026-03-05T10:00:00.500Z",
        },
      }),
    );

    for (let index = 0; index < 750; index += 1) {
      const fraction = String(index).padStart(3, "0");
      state = applyOrchestrationEvent(
        state,
        makeEvent(
          "thread.activity-appended",
          {
            threadId: thread.id,
            activity: {
              id: EventId.makeUnsafe(`reasoning-${fraction}`),
              tone: "info",
              kind: index === 749 ? "reasoning.completed" : "task.progress",
              summary: "Reasoning",
              payload: {
                taskId: "copilot-task-1",
                detail: `thought-${fraction}`,
              },
              turnId: TurnId.makeUnsafe("turn-1"),
              sequence: index + 1,
              createdAt: `2026-03-05T10:00:${String((index % 60) + 1).padStart(2, "0")}.000Z`,
            },
          },
          {
            sequence: index + 2,
            eventId: EventId.makeUnsafe(`event-reasoning-${fraction}`),
          },
        ),
      );
    }

    expect(state.threads[0]?.activities.map((activity) => activity.id)).toEqual([
      EventId.makeUnsafe("tool-history"),
      EventId.makeUnsafe("reasoning-749"),
    ]);
    expect(
      (state.threads[0]?.activities[1]?.payload as { detail?: string } | undefined)?.detail,
    ).toContain("thought-000");
    expect(
      (state.threads[0]?.activities[1]?.payload as { detail?: string } | undefined)?.detail,
    ).toContain("thought-749");
  });
});
