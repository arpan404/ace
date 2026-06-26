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
  type OrchestrationShellSnapshot,
} from "@ace/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyOrchestrationEvent,
  applyOrchestrationEvents,
  applyShellEvent,
  dismissThreadError,
  hydrateThreadFromReadModel,
  mergeServerReadModel,
  pruneHydratedThreadHistories,
  selectThreadById,
  syncServerShellSnapshot,
  syncServerReadModel,
  syncServerThreadDetailHotPath,
  useStore,
  type AppState,
} from "./store";
import {
  __resetThreadHydrationCacheForTests,
  readCachedHydratedThread,
} from "./lib/threadHydrationCache";
import { readTimelineRowsProjection, useTimelineModelStore } from "./lib/chat/timelineModelStore";
import {
  createChatMessageStreamingTextState,
  getChatMessageFullText,
} from "./lib/chat/messageText";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";

beforeEach(() => {
  __resetThreadHydrationCacheForTests();
  useStore.getState().resetToInitialState();
  useTimelineModelStore.getState().reset();
});

afterEach(() => {
  vi.useRealTimers();
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
    threadsById: {
      [thread.id]: thread,
    },
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

function makeShellThread(
  overrides: Partial<OrchestrationShellSnapshot["threads"][number]> = {},
): OrchestrationShellSnapshot["threads"][number] {
  const thread = makeReadModelThread({});
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    latestTurn: thread.latestTurn,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    deletedAt: thread.deletedAt,
    latestProposedPlanSummary: thread.latestProposedPlanSummary,
    queuedComposerMessages: thread.queuedComposerMessages,
    queuedSteerRequest: thread.queuedSteerRequest,
    session: thread.session,
    ...overrides,
  };
}

function makeShellSnapshot(
  input: {
    readonly projects?: OrchestrationShellSnapshot["projects"];
    readonly threads?: OrchestrationShellSnapshot["threads"];
    readonly snapshotSequence?: number;
  } = {},
): OrchestrationShellSnapshot {
  return {
    snapshotSequence: input.snapshotSequence ?? 1,
    updatedAt: "2026-02-27T00:00:00.000Z",
    projects: input.projects ?? [makeReadModelProject({})],
    threads: input.threads ?? [makeShellThread()],
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

  it("preserves project identity when snapshot sync has no project changes", () => {
    const readModel = makeReadModel(makeReadModelThread({}));
    const synced = syncServerReadModel(makeState(makeThread()), readModel);
    const next = syncServerReadModel(synced, readModel);

    expect(next.projects).toBe(synced.projects);
    expect(next.projects[0]).toBe(synced.projects[0]);
  });

  it("preserves project identity when merging an unchanged project", () => {
    const readModel = makeReadModel(makeReadModelThread({}));
    const synced = syncServerReadModel(makeState(makeThread()), readModel);
    const next = mergeServerReadModel(synced, readModel);

    expect(next.projects).toBe(synced.projects);
    expect(next.projects[0]).toBe(synced.projects[0]);
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

  it("maps attachment preview URLs when priming live timeline rows", async () => {
    vi.useFakeTimers();
    const threadId = ThreadId.makeUnsafe("thread-live-attachment");
    const initialState = makeState(makeThread({ id: threadId }));

    applyOrchestrationEvent(
      initialState,
      makeEvent("thread.message-sent", {
        threadId,
        messageId: MessageId.makeUnsafe("message-live-attachment"),
        role: "user",
        text: "See image",
        turnId: null,
        streaming: false,
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
        attachments: [
          {
            id: "attachment-live-1" as never,
            name: "image.png",
            type: "image",
            mimeType: "image/png",
            sizeBytes: 10,
          },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(16);

    expect(readTimelineRowsProjection(threadId).messages[0]?.attachments?.[0]).toMatchObject({
      name: "image.png",
      previewUrl: "/attachments/attachment-live-1",
    });
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

  it("marks only the requested snapshot thread as hydrated during snapshot sync", () => {
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

  it("only primes the shared hydration cache for the requested hydrated snapshot thread", () => {
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
            text: "Metadata only",
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

  it("demotes inactive hydrated threads back to metadata-only threads", () => {
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

    useTimelineModelStore.getState().primeSnapshot({
      threadId: completedThreadId,
      revision: "rev:completed",
      updatedAt: "2026-02-27T00:00:03.000Z",
      totalRows: 1,
      rows: [
        {
          id: "message:completed-assistant",
          kind: "message",
          createdAt: "2026-02-27T00:00:01.000Z",
          updatedAt: "2026-02-27T00:00:01.000Z",
          contentVersion: "snapshot:completed",
          startSourceIndex: 0,
          endSourceIndexExclusive: 1,
          turnId: completedTurnId,
          sourceRefs: [
            {
              kind: "message",
              id: "completed-assistant",
              createdAt: "2026-02-27T00:00:01.000Z",
              sourceIndex: 0,
              turnId: completedTurnId,
            },
          ],
        },
      ],
      messages: [
        {
          id: MessageId.makeUnsafe("completed-assistant"),
          role: "assistant",
          text: "Full assistant history",
          turnId: completedTurnId,
          streaming: false,
          createdAt: "2026-02-27T00:00:01.000Z",
          updatedAt: "2026-02-27T00:00:01.000Z",
        },
      ],
      activities: [],
      proposedPlans: [],
    });

    const next = pruneHydratedThreadHistories(state, [activeThreadId]);
    const completedThread = next.threads.find((thread) => thread.id === completedThreadId);
    const runningThread = next.threads.find((thread) => thread.id === runningThreadId);

    expect(completedThread?.historyLoaded).toBe(false);
    expect(completedThread?.messages).toEqual([]);
    expect(completedThread?.proposedPlans).toEqual([]);
    expect(completedThread?.latestProposedPlanSummary?.id).toBe("plan-1");
    expect(completedThread?.turnDiffSummaries).toEqual([]);
    expect(completedThread?.activities).toEqual([]);
    expect(readTimelineRowsProjection(completedThreadId).rowIds).toEqual([]);
    expect(runningThread?.historyLoaded).toBe(true);
    expect(runningThread?.messages).toHaveLength(2);
  });

  it("keeps a hydrated thread while the session still reports running", () => {
    const threadId = ThreadId.makeUnsafe("thread-stale-running-completed");
    const turnId = TurnId.makeUnsafe("turn-stale-running-completed");
    const state = makeState(
      makeThread({
        id: threadId,
        historyLoaded: true,
        messages: [
          {
            id: MessageId.makeUnsafe("stale-running-user"),
            role: "user",
            text: "Finish this",
            turnId,
            streaming: false,
            createdAt: "2026-02-27T00:00:00.000Z",
          },
        ],
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: "2026-02-27T00:00:03.000Z",
          assistantMessageId: null,
        },
        session: {
          provider: "codex",
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: turnId,
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:03.000Z",
        },
      }),
    );

    const next = pruneHydratedThreadHistories(state, []);
    const prunedThread = next.threads.find((thread) => thread.id === threadId);

    expect(prunedThread?.historyLoaded).toBe(true);
    expect(prunedThread?.messages).toHaveLength(1);
  });

  it("keeps hydrated running thread history when syncing metadata recovery snapshots", () => {
    const threadId = ThreadId.makeUnsafe("thread-running");
    const turnId = TurnId.makeUnsafe("turn-running");
    const state = makeState(
      makeThread({
        id: threadId,
        historyLoaded: true,
        messages: [
          {
            id: MessageId.makeUnsafe("running-user"),
            role: "user",
            text: "Keep the full thread visible",
            turnId,
            streaming: false,
            createdAt: "2026-02-27T00:00:00.000Z",
          },
          {
            id: MessageId.makeUnsafe("running-assistant"),
            role: "assistant",
            text: "Still working",
            turnId,
            streaming: true,
            createdAt: "2026-02-27T00:00:01.000Z",
          },
        ],
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: null,
          assistantMessageId: MessageId.makeUnsafe("running-assistant"),
        },
        session: {
          provider: "codex",
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: turnId,
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:01.000Z",
        },
      }),
    );

    const readModel = makeReadModel(
      makeReadModelThread({
        id: threadId,
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: null,
          assistantMessageId: MessageId.makeUnsafe("running-assistant"),
        },
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: "2026-02-27T00:00:01.000Z",
        },
        messages: [
          {
            id: MessageId.makeUnsafe("running-user"),
            role: "user",
            text: "Metadata snapshot",
            turnId,
            streaming: false,
            createdAt: "2026-02-27T00:00:00.000Z",
            updatedAt: "2026-02-27T00:00:00.000Z",
          },
        ],
      }),
    );

    const next = syncServerReadModel(state, readModel, { hydrateThreadId: null });

    expect(next.threads[0]?.historyLoaded).toBe(true);
    expect(next.threads[0]?.messages.map((message) => message.id)).toEqual([
      MessageId.makeUnsafe("running-user"),
      MessageId.makeUnsafe("running-assistant"),
    ]);
  });

  it("updates active session metadata while preserving hydrated history from metadata snapshots", () => {
    const threadId = ThreadId.makeUnsafe("thread-running");
    const turnId = TurnId.makeUnsafe("turn-running");
    const state = makeState(
      makeThread({
        id: threadId,
        historyLoaded: true,
        messages: [
          {
            id: MessageId.makeUnsafe("running-user"),
            role: "user",
            text: "Keep visible",
            turnId,
            streaming: false,
            createdAt: "2026-02-27T00:00:00.000Z",
          },
          {
            id: MessageId.makeUnsafe("running-assistant"),
            role: "assistant",
            text: "Still working",
            turnId,
            streaming: true,
            createdAt: "2026-02-27T00:00:01.000Z",
          },
        ],
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: null,
          assistantMessageId: MessageId.makeUnsafe("running-assistant"),
        },
        session: {
          provider: "codex",
          status: "running",
          orchestrationStatus: "running",
          commands: [{ name: "review", description: "Old review command" }],
          activeTurnId: turnId,
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:01.000Z",
        },
      }),
    );

    const readModel = makeReadModel(
      makeReadModelThread({
        id: threadId,
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: null,
          assistantMessageId: MessageId.makeUnsafe("running-assistant"),
        },
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          commands: [{ name: "review", description: "New review command" }],
          activeTurnId: turnId,
          lastError: null,
          updatedAt: "2026-02-27T00:00:02.000Z",
        },
        messages: [
          {
            id: MessageId.makeUnsafe("running-user"),
            role: "user",
            text: "Metadata snapshot",
            turnId,
            streaming: false,
            createdAt: "2026-02-27T00:00:00.000Z",
            updatedAt: "2026-02-27T00:00:00.000Z",
          },
        ],
      }),
    );

    const next = syncServerReadModel(state, readModel, { hydrateThreadId: null });

    expect(next.threads[0]?.historyLoaded).toBe(true);
    expect(next.threads[0]?.messages).toBe(state.threads[0]?.messages);
    expect(next.threads[0]?.session?.commands).toEqual([
      { name: "review", description: "New review command" },
    ]);
  });

  it("preserves newer live assistant text when a stale hydrated snapshot arrives", () => {
    const threadId = ThreadId.makeUnsafe("thread-stale-hydration");
    const turnId = TurnId.makeUnsafe("turn-stale-hydration");
    const assistantMessageId = MessageId.makeUnsafe("assistant-stale-hydration");
    const state = makeState(
      makeThread({
        id: threadId,
        historyLoaded: true,
        messages: [
          {
            id: MessageId.makeUnsafe("user-stale-hydration"),
            role: "user",
            text: "Investigate",
            turnId,
            streaming: false,
            sequence: 1,
            createdAt: "2026-02-27T00:00:00.000Z",
          },
          {
            id: assistantMessageId,
            role: "assistant",
            text: "",
            streamingTextState: createChatMessageStreamingTextState(
              "I checked contracts and adapters.",
            ),
            turnId,
            streaming: true,
            sequence: 3,
            createdAt: "2026-02-27T00:00:01.000Z",
          },
        ],
      }),
    );

    const readModelThread = makeReadModelThread({
      id: threadId,
      messages: [
        {
          id: MessageId.makeUnsafe("user-stale-hydration"),
          role: "user",
          text: "Investigate",
          turnId,
          streaming: false,
          sequence: 1,
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
        {
          id: assistantMessageId,
          role: "assistant",
          text: "I checked",
          turnId,
          streaming: true,
          sequence: 2,
          createdAt: "2026-02-27T00:00:01.000Z",
          updatedAt: "2026-02-27T00:00:01.000Z",
        },
      ],
    });

    const next = hydrateThreadFromReadModel(state, readModelThread);
    const assistantMessage = next.threads[0]?.messages.find(
      (message) => message.id === assistantMessageId,
    );

    expect(assistantMessage?.streaming).toBe(true);
    expect(getChatMessageFullText(assistantMessage!)).toBe("I checked contracts and adapters.");
  });

  it("does not let snapshot sync shrink accumulated live assistant text", () => {
    const threadId = ThreadId.makeUnsafe("thread-stale-sync");
    const turnId = TurnId.makeUnsafe("turn-stale-sync");
    const assistantMessageId = MessageId.makeUnsafe("assistant-stale-sync");
    const state = makeState(
      makeThread({
        id: threadId,
        historyLoaded: true,
        messages: [
          {
            id: MessageId.makeUnsafe("user-stale-sync"),
            role: "user",
            text: "Investigate",
            turnId,
            streaming: false,
            sequence: 1,
            createdAt: "2026-02-27T00:00:00.000Z",
          },
          {
            id: assistantMessageId,
            role: "assistant",
            text: "",
            streamingTextState: createChatMessageStreamingTextState(
              "I found one concrete lead already.",
            ),
            turnId,
            streaming: true,
            sequence: 3,
            createdAt: "2026-02-27T00:00:01.000Z",
          },
        ],
      }),
    );

    const next = syncServerReadModel(
      state,
      makeReadModel(
        makeReadModelThread({
          id: threadId,
          messages: [
            {
              id: MessageId.makeUnsafe("user-stale-sync"),
              role: "user",
              text: "Investigate",
              turnId,
              streaming: false,
              sequence: 1,
              createdAt: "2026-02-27T00:00:00.000Z",
              updatedAt: "2026-02-27T00:00:00.000Z",
            },
            {
              id: assistantMessageId,
              role: "assistant",
              text: "I found one",
              turnId,
              streaming: true,
              sequence: 2,
              createdAt: "2026-02-27T00:00:01.000Z",
              updatedAt: "2026-02-27T00:00:01.000Z",
            },
          ],
        }),
      ),
    );
    const assistantMessage = next.threads[0]?.messages.find(
      (message) => message.id === assistantMessageId,
    );

    expect(getChatMessageFullText(assistantMessage!)).toBe("I found one concrete lead already.");
  });

  it("derives sidebar proposed-plan state from latestProposedPlanSummary for metadata threads", () => {
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

describe("store shell hot path", () => {
  it("preserves hydrated messages when applying a shell snapshot", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const hydrated = syncServerThreadDetailHotPath(
      makeState(makeThread({ historyLoaded: false })),
      makeReadModelThread({
        id: threadId,
        messages: [
          {
            id: MessageId.makeUnsafe("message-1"),
            role: "assistant",
            text: "kept",
            turnId: null,
            streaming: false,
            createdAt: "2026-02-27T00:00:01.000Z",
            updatedAt: "2026-02-27T00:00:01.000Z",
          },
        ],
      }),
    );

    const next = syncServerShellSnapshot(
      hydrated,
      makeShellSnapshot({
        snapshotSequence: 10,
        threads: [
          makeShellThread({
            id: threadId,
            title: "Renamed",
            updatedAt: "2026-02-27T00:00:02.000Z",
          }),
        ],
      }),
    );

    expect(next.threads[0]?.title).toBe("Renamed");
    expect(next.threads[0]?.historyLoaded).toBe(true);
    expect(next.threads[0]?.messages.map((message) => message.id)).toEqual([
      MessageId.makeUnsafe("message-1"),
    ]);
  });

  it("preserves active runtime state when a shell snapshot contains stale idle metadata", () => {
    const threadId = ThreadId.makeUnsafe("thread-live-shell");
    const turnId = TurnId.makeUnsafe("turn-live-shell");
    const runningThread = makeThread({
      id: threadId,
      historyLoaded: true,
      latestTurn: {
        turnId,
        state: "running",
        requestedAt: "2026-02-27T00:00:00.000Z",
        startedAt: "2026-02-27T00:00:01.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
      session: {
        provider: "codex",
        status: "running",
        orchestrationStatus: "running",
        activeTurnId: turnId,
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:05.000Z",
      },
      messages: [
        {
          id: MessageId.makeUnsafe("live-message"),
          role: "assistant",
          text: "Still streaming",
          turnId,
          streaming: true,
          createdAt: "2026-02-27T00:00:02.000Z",
        },
      ],
    });

    const next = syncServerShellSnapshot(
      makeState(runningThread),
      makeShellSnapshot({
        snapshotSequence: 20,
        threads: [
          makeShellThread({
            id: threadId,
            latestTurn: null,
            session: {
              threadId,
              status: "idle",
              providerName: "codex",
              runtimeMode: DEFAULT_RUNTIME_MODE,
              activeTurnId: null,
              lastError: null,
              updatedAt: "2026-02-27T00:00:03.000Z",
            },
          }),
        ],
      }),
    );

    expect(next.threads[0]?.latestTurn?.state).toBe("running");
    expect(next.threads[0]?.session?.status).toBe("running");
    expect(next.threads[0]?.historyLoaded).toBe(true);
  });

  it("preserves hydrated messages when applying a shell upsert event", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const hydrated = syncServerThreadDetailHotPath(
      makeState(makeThread({ historyLoaded: false })),
      makeReadModelThread({
        id: threadId,
        messages: [
          {
            id: MessageId.makeUnsafe("message-1"),
            role: "assistant",
            text: "kept",
            turnId: null,
            streaming: false,
            createdAt: "2026-02-27T00:00:01.000Z",
            updatedAt: "2026-02-27T00:00:01.000Z",
          },
        ],
      }),
    );

    const next = applyShellEvent(hydrated, {
      kind: "thread-upserted",
      sequence: 11,
      thread: makeShellThread({
        id: threadId,
        title: "Live Rename",
        updatedAt: "2026-02-27T00:00:03.000Z",
      }),
    });

    expect(next.threads[0]?.title).toBe("Live Rename");
    expect(next.threads[0]?.historyLoaded).toBe(true);
    expect(next.threads[0]?.messages.map((message) => message.id)).toEqual([
      MessageId.makeUnsafe("message-1"),
    ]);
  });

  it("hydrates only the targeted thread detail hot path", () => {
    const firstThreadId = ThreadId.makeUnsafe("thread-1");
    const secondThreadId = ThreadId.makeUnsafe("thread-2");
    const emptyState: AppState = {
      ...makeState(makeThread()),
      threads: [],
      threadsById: {},
      sidebarThreadsById: {},
      threadIdsByProjectId: {},
    };
    const shellState = syncServerShellSnapshot(
      emptyState,
      makeShellSnapshot({
        threads: [
          makeShellThread({ id: firstThreadId }),
          makeShellThread({ id: secondThreadId, title: "Second" }),
        ],
      }),
    );

    const next = syncServerThreadDetailHotPath(
      shellState,
      makeReadModelThread({
        id: secondThreadId,
        title: "Second",
        messages: [
          {
            id: MessageId.makeUnsafe("target-message"),
            role: "assistant",
            text: "target",
            turnId: null,
            streaming: false,
            createdAt: "2026-02-27T00:00:02.000Z",
            updatedAt: "2026-02-27T00:00:02.000Z",
          },
        ],
      }),
    );

    expect(next.threads.find((thread) => thread.id === firstThreadId)?.historyLoaded).toBe(false);
    expect(next.threads.find((thread) => thread.id === secondThreadId)?.historyLoaded).toBe(true);
    expect(next.threads.find((thread) => thread.id === secondThreadId)?.messages[0]?.id).toBe(
      MessageId.makeUnsafe("target-message"),
    );
  });

  it("removes sidebar and index state when applying a shell thread removal", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const synced = syncServerShellSnapshot(
      {
        ...makeState(makeThread()),
        threads: [],
        threadsById: {},
        sidebarThreadsById: {},
        threadIdsByProjectId: {},
      },
      makeShellSnapshot({ threads: [makeShellThread({ id: threadId })] }),
    );

    const next = applyShellEvent(synced, {
      kind: "thread-removed",
      sequence: 12,
      threadId,
    });

    expect(next.threadsById?.[threadId]).toBeUndefined();
    expect(next.sidebarThreadsById[threadId]).toBeUndefined();
    expect(next.threadIdsByProjectId[ProjectId.makeUnsafe("project-1")] ?? []).toEqual([]);
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

  it("keeps the active thread selector stable when an unrelated thread updates", () => {
    const activeThreadId = ThreadId.makeUnsafe("thread-active");
    const unrelatedThreadId = ThreadId.makeUnsafe("thread-unrelated");
    const activeThread = makeThread({ id: activeThreadId, title: "Active thread" });
    const unrelatedThread = makeThread({
      id: unrelatedThreadId,
      title: "Unrelated thread",
    });
    const state: AppState = {
      ...makeState(activeThread),
      threads: [activeThread, unrelatedThread],
      threadsById: {
        [activeThread.id]: activeThread,
        [unrelatedThread.id]: unrelatedThread,
      },
      threadIdsByProjectId: {
        [activeThread.projectId]: [activeThread.id, unrelatedThread.id],
      },
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.meta-updated", {
        threadId: unrelatedThreadId,
        title: "Updated unrelated thread",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.threadsById?.[activeThreadId]).toBe(activeThread);
    expect(selectThreadById(activeThreadId)(next)).toBe(activeThread);
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

  it("removes dismissed error state when a thread is deleted", () => {
    const thread = makeThread();
    const state = {
      ...makeState(thread),
      dismissedThreadErrorKeysById: {
        [thread.id]: "dismissed-error",
      },
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.deleted", {
        threadId: thread.id,
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.threads).toEqual([]);
    expect(next.dismissedThreadErrorKeysById).toEqual({});
  });

  it("removes dismissed error state for threads omitted by full snapshot sync", () => {
    const retainedThreadId = ThreadId.makeUnsafe("thread-retained");
    const removedThreadId = ThreadId.makeUnsafe("thread-removed");
    const retainedThread = makeThread({ id: retainedThreadId });
    const removedThread = makeThread({ id: removedThreadId });
    const state = {
      ...makeState(retainedThread),
      threads: [retainedThread, removedThread],
      threadsById: {
        [retainedThread.id]: retainedThread,
        [removedThread.id]: removedThread,
      },
      threadIdsByProjectId: {
        [retainedThread.projectId]: [retainedThread.id, removedThread.id],
      },
      dismissedThreadErrorKeysById: {
        [retainedThread.id]: "retained-error",
        [removedThread.id]: "removed-error",
      },
    };

    const next = syncServerReadModel(
      state,
      makeReadModel(
        makeReadModelThread({
          id: retainedThreadId,
        }),
      ),
    );

    expect(next.threads.map((thread) => thread.id)).toEqual([retainedThreadId]);
    expect(next.dismissedThreadErrorKeysById).toEqual({
      [retainedThreadId]: "retained-error",
    });
  });

  it("removes project-owned thread state when a project is deleted", () => {
    const thread = makeThread();
    const state = {
      ...makeState(thread),
      sidebarThreadsById: {
        [thread.id]: {
          id: thread.id,
          projectId: thread.projectId,
          title: thread.title,
          interactionMode: thread.interactionMode,
          session: thread.session,
          createdAt: thread.createdAt,
          archivedAt: thread.archivedAt,
          updatedAt: thread.updatedAt,
          latestTurn: thread.latestTurn,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          isErrorDismissed: true,
        },
      },
      dismissedThreadErrorKeysById: {
        [thread.id]: "dismissed-error",
      },
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("project.deleted", {
        projectId: thread.projectId,
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.projects).toEqual([]);
    expect(next.threads).toEqual([]);
    expect(next.threadsById).toEqual({});
    expect(next.sidebarThreadsById).toEqual({});
    expect(next.threadIdsByProjectId).toEqual({});
    expect(next.dismissedThreadErrorKeysById).toEqual({});
  });

  it("removes project-owned thread state when read-model ownership is removed", () => {
    const removedProjectId = ProjectId.makeUnsafe("project-removed");
    const retainedProjectId = ProjectId.makeUnsafe("project-retained");
    const removedThread = makeThread({
      id: ThreadId.makeUnsafe("thread-removed"),
      projectId: removedProjectId,
    });
    const retainedThread = makeThread({
      id: ThreadId.makeUnsafe("thread-retained"),
      projectId: retainedProjectId,
    });
    useStore.setState({
      projects: [
        {
          id: removedProjectId,
          name: "Removed",
          cwd: "/tmp/removed",
          icon: null,
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          archivedAt: null,
          scripts: [],
        },
        {
          id: retainedProjectId,
          name: "Retained",
          cwd: "/tmp/retained",
          icon: null,
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          archivedAt: null,
          scripts: [],
        },
      ],
      threads: [removedThread, retainedThread],
      threadsById: {
        [removedThread.id]: removedThread,
        [retainedThread.id]: retainedThread,
      },
      sidebarThreadsById: {
        [removedThread.id]: {
          id: removedThread.id,
          projectId: removedThread.projectId,
          title: removedThread.title,
          interactionMode: removedThread.interactionMode,
          session: removedThread.session,
          createdAt: removedThread.createdAt,
          archivedAt: removedThread.archivedAt,
          updatedAt: removedThread.updatedAt,
          latestTurn: removedThread.latestTurn,
          branch: removedThread.branch,
          worktreePath: removedThread.worktreePath,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          isErrorDismissed: true,
        },
      },
      threadIdsByProjectId: {
        [removedProjectId]: [removedThread.id],
        [retainedProjectId]: [retainedThread.id],
      },
      dismissedThreadErrorKeysById: {
        [removedThread.id]: "dismissed-error",
        [retainedThread.id]: "retained-error",
      },
      bootstrapComplete: true,
    });

    useStore.getState().removeReadModelEntities({
      projectIds: [removedProjectId],
      threadIds: [],
    });

    const next = useStore.getState();
    expect(next.projects.map((project) => project.id)).toEqual([retainedProjectId]);
    expect(next.threads.map((thread) => thread.id)).toEqual([retainedThread.id]);
    expect(next.threadsById?.[removedThread.id]).toBeUndefined();
    expect(next.threadsById?.[retainedThread.id]).toBe(retainedThread);
    expect(next.sidebarThreadsById[removedThread.id]).toBeUndefined();
    expect(next.threadIdsByProjectId[removedProjectId]).toBeUndefined();
    expect(next.threadIdsByProjectId[retainedProjectId]).toEqual([retainedThread.id]);
    expect(next.dismissedThreadErrorKeysById).toEqual({
      [retainedThread.id]: "retained-error",
    });
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
      mode: "best" as const,
      createdAt: "2026-02-27T00:00:01.000Z",
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.created", {
        threadId,
        projectId,
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

  it("retains chat fork metadata from thread.created events", () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const threadId = ThreadId.makeUnsafe("thread-fork");
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

    const fork = {
      sourceThreadId,
      createdAt: "2026-02-27T00:00:01.000Z",
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.created", {
        threadId,
        projectId,
        title: "Forked thread",
        modelSelection: {
          provider: "codex",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
        },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        fork,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.threads[0]?.fork).toEqual(fork);
    expect(next.sidebarThreadsById[threadId]?.fork).toEqual(fork);
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

  it("does not replace sidebar summaries for sub-second streaming churn", () => {
    const threadId = ThreadId.makeUnsafe("thread-streaming-sidebar");
    const messageId = MessageId.makeUnsafe("message-streaming-sidebar");
    const turnId = TurnId.makeUnsafe("turn-streaming-sidebar");
    const state = makeState(makeThread({ id: threadId }));

    const first = applyOrchestrationEvent(
      state,
      makeEvent(
        "thread.message-sent",
        {
          threadId,
          messageId,
          role: "assistant",
          text: "hel",
          turnId,
          streaming: true,
          createdAt: "2026-02-27T00:00:00.100Z",
          updatedAt: "2026-02-27T00:00:00.100Z",
        },
        {
          occurredAt: "2026-02-27T00:00:00.100Z",
        },
      ),
    );
    const sidebarAfterFirstChunk = first.sidebarThreadsById;

    const second = applyOrchestrationEvent(
      first,
      makeEvent(
        "thread.message-sent",
        {
          threadId,
          messageId,
          role: "assistant",
          text: "lo",
          turnId,
          streaming: true,
          createdAt: "2026-02-27T00:00:00.500Z",
          updatedAt: "2026-02-27T00:00:00.500Z",
        },
        {
          occurredAt: "2026-02-27T00:00:00.500Z",
        },
      ),
    );

    expect(second.threads[0]?.updatedAt).toBe("2026-02-27T00:00:00.500Z");
    expect(second.sidebarThreadsById).toBe(sidebarAfterFirstChunk);

    const completed = applyOrchestrationEvent(
      second,
      makeEvent(
        "thread.message-sent",
        {
          threadId,
          messageId,
          role: "assistant",
          text: "hello",
          turnId,
          streaming: false,
          createdAt: "2026-02-27T00:00:00.700Z",
          updatedAt: "2026-02-27T00:00:00.700Z",
        },
        {
          occurredAt: "2026-02-27T00:00:00.700Z",
        },
      ),
    );

    expect(completed.sidebarThreadsById).not.toBe(sidebarAfterFirstChunk);
    expect(completed.sidebarThreadsById[threadId]?.latestTurn?.state).toBe("completed");
  });

  it("projects assistant messages into timeline rows for metadata-only threads", () => {
    const threadId = ThreadId.makeUnsafe("thread-metadata-live-assistant");
    const messageId = MessageId.makeUnsafe("message-metadata-live-assistant");
    const turnId = TurnId.makeUnsafe("turn-metadata-live-assistant");
    const state = makeState(
      makeThread({
        id: threadId,
        historyLoaded: false,
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent(
        "thread.message-sent",
        {
          threadId,
          messageId,
          role: "assistant",
          text: "streamed assistant text",
          turnId,
          streaming: true,
          createdAt: "2026-02-27T00:00:01.000Z",
          updatedAt: "2026-02-27T00:00:01.000Z",
        },
        {
          sequence: 2,
          occurredAt: "2026-02-27T00:00:01.000Z",
        },
      ),
    );

    expect(next.threads[0]?.messages).toEqual([]);
    expect(next.threads[0]?.latestTurn?.state).toBe("running");
    expect(readTimelineRowsProjection(threadId).messages.map((message) => message.text)).toEqual([
      "streamed assistant text",
    ]);
    expect(readTimelineRowsProjection(threadId).rowIds).toEqual([
      "message:message-metadata-live-assistant",
    ]);
  });

  it("keeps streamed assistant text when a metadata-only thread receives an empty final event", () => {
    const threadId = ThreadId.makeUnsafe("thread-metadata-empty-final");
    const messageId = MessageId.makeUnsafe("message-metadata-empty-final");
    const turnId = TurnId.makeUnsafe("turn-metadata-empty-final");
    const state = makeState(
      makeThread({
        id: threadId,
        historyLoaded: false,
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );

    const live = applyOrchestrationEvent(
      state,
      makeEvent(
        "thread.message-sent",
        {
          threadId,
          messageId,
          role: "assistant",
          text: "hi",
          turnId,
          streaming: true,
          createdAt: "2026-02-27T00:00:01.000Z",
          updatedAt: "2026-02-27T00:00:01.000Z",
        },
        {
          sequence: 2,
          occurredAt: "2026-02-27T00:00:01.000Z",
        },
      ),
    );
    applyOrchestrationEvent(
      live,
      makeEvent(
        "thread.message-sent",
        {
          threadId,
          messageId,
          role: "assistant",
          text: "",
          turnId,
          streaming: false,
          createdAt: "2026-02-27T00:00:01.000Z",
          updatedAt: "2026-02-27T00:00:02.000Z",
        },
        {
          sequence: 3,
          occurredAt: "2026-02-27T00:00:02.000Z",
        },
      ),
    );

    expect(readTimelineRowsProjection(threadId).messages[0]).toMatchObject({
      text: "hi",
      streaming: false,
    });
  });

  it("does not replace sidebar summaries for sub-second tool activity churn", () => {
    const threadId = ThreadId.makeUnsafe("thread-activity-sidebar");
    const turnId = TurnId.makeUnsafe("turn-activity-sidebar");
    const state = makeState(makeThread({ id: threadId }));

    const first = applyOrchestrationEvent(
      state,
      makeEvent(
        "thread.activity-appended",
        {
          threadId,
          activity: {
            id: EventId.makeUnsafe("activity-output-1"),
            tone: "tool",
            kind: "tool.updated",
            summary: "Command output",
            payload: {
              itemId: "command-1",
              streamKind: "command_output",
              terminalOutput: "hello",
            },
            turnId,
            createdAt: "2026-02-27T00:00:00.100Z",
          },
        },
        {
          occurredAt: "2026-02-27T00:00:00.100Z",
        },
      ),
    );
    const sidebarAfterFirstActivity = first.sidebarThreadsById;

    const second = applyOrchestrationEvent(
      first,
      makeEvent(
        "thread.activity-appended",
        {
          threadId,
          activity: {
            id: EventId.makeUnsafe("activity-output-2"),
            tone: "tool",
            kind: "tool.updated",
            summary: "Command output",
            payload: {
              itemId: "command-1",
              streamKind: "command_output",
              terminalOutput: " world",
            },
            turnId,
            createdAt: "2026-02-27T00:00:00.500Z",
          },
        },
        {
          occurredAt: "2026-02-27T00:00:00.500Z",
        },
      ),
    );

    expect(second.threads[0]?.updatedAt).toBe("2026-02-27T00:00:00.500Z");
    expect(second.sidebarThreadsById).toBe(sidebarAfterFirstActivity);
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

  it("keeps metadata thread plan bodies unloaded while refreshing the latest plan summary", () => {
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

  it("keeps metadata threads from regrowing message or diff history from background events", () => {
    const thread = makeThread({
      historyLoaded: false,
      messages: [],
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

    expect(next.threads[0]?.messages).toEqual([]);
    expect(next.threads[0]?.turnDiffSummaries).toEqual([]);
    expect(next.threads[0]?.activities.map((activity) => activity.kind)).toEqual([
      "tool.started",
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

  it("publishes live timeline rows once per orchestration batch", () => {
    const thread = makeThread();
    const state = makeState(thread);
    let timelineStateChangeCount = 0;
    const unsubscribe = useTimelineModelStore.subscribe(() => {
      timelineStateChangeCount += 1;
    });

    try {
      applyOrchestrationEvents(state, [
        makeEvent("thread.message-sent", {
          threadId: thread.id,
          messageId: MessageId.makeUnsafe("batch-message-1"),
          role: "assistant",
          text: "Hello",
          turnId: TurnId.makeUnsafe("turn-batch"),
          streaming: true,
          createdAt: "2026-02-27T00:00:01.000Z",
          updatedAt: "2026-02-27T00:00:01.000Z",
        }),
        makeEvent("thread.activity-appended", {
          threadId: thread.id,
          activity: {
            id: EventId.makeUnsafe("batch-activity-1"),
            tone: "tool",
            kind: "tool.started",
            summary: "Tool started",
            payload: {},
            turnId: TurnId.makeUnsafe("turn-batch"),
            createdAt: "2026-02-27T00:00:02.000Z",
          },
        }),
      ]);
    } finally {
      unsubscribe();
    }

    expect(timelineStateChangeCount).toBe(1);
    expect(readTimelineRowsProjection(thread.id).rowIds).toEqual([
      "message:batch-message-1",
      "activity:batch-activity-1",
    ]);
  });

  it("preserves activity semantics when consecutive same-thread activity events are batched", async () => {
    const thread = makeThread();
    const state = makeState(thread);
    const events = [
      makeEvent(
        "thread.activity-appended",
        {
          threadId: thread.id,
          activity: {
            id: EventId.makeUnsafe("tool-started"),
            tone: "tool",
            kind: "tool.started",
            summary: "Ran command",
            payload: { itemId: "command-1" },
            turnId: TurnId.makeUnsafe("turn-1"),
            sequence: 10,
            createdAt: "2026-02-27T00:00:01.000Z",
          },
        },
        {
          sequence: 10,
          occurredAt: "2026-02-27T00:00:01.000Z",
        },
      ),
      makeEvent(
        "thread.activity-appended",
        {
          threadId: thread.id,
          activity: {
            id: EventId.makeUnsafe("tool-output"),
            tone: "tool",
            kind: "tool.updated",
            summary: "Command output",
            payload: {
              itemId: "command-1",
              terminalOutput: "done\n",
              streamKind: "command_output",
            },
            turnId: TurnId.makeUnsafe("turn-1"),
            sequence: 11,
            createdAt: "2026-02-27T00:00:02.000Z",
          },
        },
        {
          sequence: 11,
          occurredAt: "2026-02-27T00:00:02.000Z",
        },
      ),
    ];

    const batched = applyOrchestrationEvents(state, events);
    const sequential = events.reduce(
      (nextState, event) => applyOrchestrationEvent(nextState, event),
      state,
    );

    expect(batched.threads[0]?.activities).toEqual(sequential.threads[0]?.activities);
    expect(batched.threads[0]?.updatedAt).toBe("2026-02-27T00:00:02.000Z");

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readTimelineRowsProjection(thread.id).activities.map((activity) => activity.id)).toEqual(
      ["tool-started", "tool-output"],
    );
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

  it("uses the triggering user message time as the live turn start fallback", () => {
    const turnId = TurnId.makeUnsafe("turn-start-fallback");
    const thread = makeThread({
      messages: [
        {
          id: MessageId.makeUnsafe("user-start-fallback"),
          role: "user",
          text: "Start work",
          turnId: null,
          streaming: false,
          createdAt: "2026-02-27T00:00:01.000Z",
        },
      ],
    });
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
          activeTurnId: turnId,
          lastError: null,
          updatedAt: "2026-02-27T00:00:05.000Z",
        },
      }),
    );

    expect(next.threads[0]?.latestTurn).toMatchObject({
      turnId,
      state: "running",
      requestedAt: "2026-02-27T00:00:01.000Z",
      startedAt: "2026-02-27T00:00:01.000Z",
    });
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

  it("preserves diff summary identity when an assistant message is already authoritatively bound", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    const turnDiffSummaries: Thread["turnDiffSummaries"] = [
      {
        turnId,
        completedAt: "2026-02-27T00:00:02.000Z",
        status: "ready",
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
        assistantMessageId: MessageId.makeUnsafe("assistant-real"),
        files: [{ path: "src/app.ts", additions: 1, deletions: 0 }],
      },
    ];
    const state = makeState(
      makeThread({
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: "2026-02-27T00:00:02.000Z",
          assistantMessageId: MessageId.makeUnsafe("assistant-real"),
        },
        turnDiffSummaries,
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

    expect(next.threads[0]?.turnDiffSummaries).toBe(turnDiffSummaries);
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

  it("preserves full latest-turn activity while running and after completion", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    const thread = makeThread({
      latestTurn: {
        turnId,
        state: "running",
        requestedAt: "2026-03-05T10:00:00.000Z",
        startedAt: "2026-03-05T10:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });
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
          turnId,
          createdAt: "2026-03-05T10:00:00.500Z",
        },
      }),
    );

    for (let index = 0; index < 5; index += 1) {
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
              turnId,
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
      EventId.makeUnsafe("reasoning-000"),
      EventId.makeUnsafe("reasoning-001"),
      EventId.makeUnsafe("reasoning-002"),
      EventId.makeUnsafe("reasoning-003"),
      EventId.makeUnsafe("reasoning-004"),
    ]);
    expect(
      (state.threads[0]?.activities[1]?.payload as { detail?: string } | undefined)?.detail,
    ).toBe("thought-000");

    state = applyOrchestrationEvent(
      state,
      makeEvent(
        "thread.message-sent",
        {
          threadId: thread.id,
          messageId: MessageId.makeUnsafe("assistant-completed-turn-1"),
          role: "assistant",
          text: "Done",
          turnId,
          streaming: false,
          sequence: 10,
          createdAt: "2026-03-05T10:01:00.000Z",
          updatedAt: "2026-03-05T10:01:00.000Z",
        },
        {
          sequence: 100,
          eventId: EventId.makeUnsafe("event-assistant-completed-turn-1"),
        },
      ),
    );

    expect(state.threads[0]?.activities.map((activity) => activity.id)).toEqual([
      EventId.makeUnsafe("tool-history"),
      EventId.makeUnsafe("reasoning-004"),
    ]);
    expect(state.threads[0]?.activities[0]?.payload).toMatchObject({
      detail: "packages/contracts/src/model.ts",
    });
    expect(state.threads[0]?.activities[1]?.payload).toMatchObject({
      taskId: "copilot-task-1",
      detail: "thought-000 thought-001 thought-002 thought-003 thought-004",
    });
  });
});
