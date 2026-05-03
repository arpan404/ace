import { describe, expect, it, vi } from "vitest";
import type {
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationThread,
  OrchestrationThreadActivity,
} from "@ace/contracts";

vi.mock("react", () => ({
  useCallback: (value: unknown) => value,
  useEffect: vi.fn(),
  useMemo: (factory: () => unknown) => factory(),
  useState: (initial: unknown) => [initial, vi.fn()],
}));

vi.mock("../rpc/ConnectionManager", () => ({
  connectionManager: {
    getConnections: vi.fn(() => []),
    onStatusChange: vi.fn(() => vi.fn()),
  },
}));

vi.mock("../store/MobilePreferencesStore", () => ({
  useMobilePreferencesStore: vi.fn((selector: (state: unknown) => unknown) =>
    selector({
      sidebarProjectSortOrder: "last_user_message",
      sidebarThreadSortOrder: "updated_at",
    }),
  ),
}));

import {
  aggregateMobileOrchestrationSnapshots,
  compareMobileThreads,
  resolveMobileThreadErrorDismissalKey,
  resolveMobileThreadStatus,
} from "./mobileData";

const BASE_MODEL_SELECTION = { provider: "codex", model: "gpt-5.4" } as const;

function project(overrides: Partial<OrchestrationProject>): OrchestrationProject {
  return {
    id: "project-a" as never,
    title: "Project A",
    workspaceRoot: "/workspace/project-a",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-05-01T10:00:00.000Z",
    updatedAt: "2026-05-01T10:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function thread(overrides: Partial<OrchestrationThread>): OrchestrationThread {
  const createdAt = overrides.createdAt ?? "2026-05-01T10:00:00.000Z";
  return {
    id: "thread-a" as never,
    projectId: "project-a" as never,
    title: "Thread A",
    modelSelection: BASE_MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    latestProposedPlanSummary: null,
    queuedComposerMessages: [],
    queuedSteerRequest: null,
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function activity(overrides: Partial<OrchestrationThreadActivity>): OrchestrationThreadActivity {
  return {
    id: "event-a" as never,
    tone: "approval",
    kind: "approval.requested",
    summary: "Approval required",
    payload: {},
    turnId: null,
    createdAt: "2026-05-01T12:00:00.000Z",
    ...overrides,
  };
}

function snapshot(input: {
  projects: ReadonlyArray<OrchestrationProject>;
  threads: ReadonlyArray<OrchestrationThread>;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    projects: [...input.projects],
    threads: [...input.threads],
    updatedAt: "2026-05-01T12:00:00.000Z",
  };
}

describe("mobileData", () => {
  it("aggregates multi-host snapshots and filters archived/deleted records", () => {
    const projectA = project({ id: "project-a" as never, title: "Alpha" });
    const projectB = project({
      id: "project-b" as never,
      title: "Beta",
      updatedAt: "2026-05-01T11:00:00.000Z",
    });
    const hiddenProject = project({
      id: "project-hidden" as never,
      title: "Hidden",
      archivedAt: "2026-05-01T12:00:00.000Z",
    });
    const runningThread = thread({
      id: "thread-running" as never,
      projectId: "project-a" as never,
      updatedAt: "2026-05-01T11:30:00.000Z",
      session: {
        threadId: "thread-running" as never,
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: "turn-running" as never,
        lastError: null,
        updatedAt: "2026-05-01T11:30:00.000Z",
      },
      messages: [
        {
          id: "message-running" as never,
          role: "user",
          text: "Ship the mobile surface",
          attachments: [],
          turnId: null,
          streaming: false,
          createdAt: "2026-05-01T11:20:00.000Z",
          updatedAt: "2026-05-01T11:20:00.000Z",
        },
      ],
    });
    const completedThread = thread({
      id: "thread-completed" as never,
      projectId: "project-b" as never,
      updatedAt: "2026-05-01T11:10:00.000Z",
      latestTurn: {
        turnId: "turn-completed" as never,
        state: "completed",
        requestedAt: "2026-05-01T11:00:00.000Z",
        startedAt: "2026-05-01T11:01:00.000Z",
        completedAt: "2026-05-01T11:10:00.000Z",
        assistantMessageId: null,
      },
    });
    const deletedThread = thread({
      id: "thread-deleted" as never,
      projectId: "project-a" as never,
      deletedAt: "2026-05-01T12:00:00.000Z",
    });

    const result = aggregateMobileOrchestrationSnapshots({
      connections: [
        { host: { id: "host-a", name: "Studio" } },
        { host: { id: "host-b", name: "Laptop" } },
      ],
      snapshots: {
        "host-a": snapshot({
          projects: [projectA, hiddenProject],
          threads: [runningThread, deletedThread],
        }),
        "host-b": snapshot({
          projects: [projectB],
          threads: [completedThread],
        }),
      },
      sidebarProjectSortOrder: "updated_at",
      sidebarThreadSortOrder: "updated_at",
    });

    expect(result.projects.map((entry) => entry.project.id)).toEqual(["project-a", "project-b"]);
    expect(result.threads.map((entry) => entry.thread.id)).toEqual([
      "thread-running",
      "thread-completed",
    ]);
    expect(result.activeThreads.map((entry) => entry.thread.id)).toEqual(["thread-running"]);
    expect(result.attentionThreads.map((entry) => entry.thread.id)).toEqual(["thread-completed"]);
    expect(result.projects.find((entry) => entry.project.id === "project-a")?.liveCount).toBe(1);
    expect(result.threads[0]?.preview).toBe("Ship the mobile surface");
  });

  it("sorts threads by last user message when requested", () => {
    const olderUpdatedThread = thread({
      id: "thread-latest-prompt" as never,
      updatedAt: "2026-05-01T10:00:00.000Z",
      messages: [
        {
          id: "message-a" as never,
          role: "user",
          text: "Latest prompt",
          attachments: [],
          turnId: null,
          streaming: false,
          createdAt: "2026-05-01T12:00:00.000Z",
          updatedAt: "2026-05-01T12:00:00.000Z",
        },
      ],
    });
    const newerUpdatedThread = thread({
      id: "thread-newer-update" as never,
      updatedAt: "2026-05-01T11:30:00.000Z",
      messages: [
        {
          id: "message-b" as never,
          role: "assistant",
          text: "Background output",
          attachments: [],
          turnId: null,
          streaming: false,
          createdAt: "2026-05-01T11:30:00.000Z",
          updatedAt: "2026-05-01T11:30:00.000Z",
        },
      ],
    });

    expect(
      compareMobileThreads(olderUpdatedThread, newerUpdatedThread, "updated_at"),
    ).toBeGreaterThan(0);
    expect(
      compareMobileThreads(olderUpdatedThread, newerUpdatedThread, "last_user_message"),
    ).toBeLessThan(0);
  });

  it("prioritizes input and diff-ready status for attention lists", () => {
    const inputThread = thread({
      id: "thread-input" as never,
      activities: [activity({ kind: "user-input.requested", tone: "approval" })],
    });
    const reviewThread = thread({
      id: "thread-review" as never,
      checkpoints: [
        {
          turnId: "turn-review" as never,
          checkpointTurnCount: 1,
          checkpointRef: "checkpoint-ref" as never,
          status: "ready",
          source: "git-checkpoint",
          files: [],
          assistantMessageId: null,
          completedAt: "2026-05-01T12:00:00.000Z",
        },
      ],
    });

    expect(resolveMobileThreadStatus(inputThread)).toMatchObject({
      bucket: "input",
      label: "Input required",
    });
    expect(resolveMobileThreadStatus(reviewThread)).toMatchObject({
      bucket: "review",
      label: "Diff ready",
    });
  });

  it("suppresses a dismissed session error until the error key changes", () => {
    const erroredThread = thread({
      id: "thread-error" as never,
      session: {
        threadId: "thread-error" as never,
        status: "error",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: "Provider disconnected",
        updatedAt: "2026-05-01T12:00:00.000Z",
      },
    });
    const dismissalKey = resolveMobileThreadErrorDismissalKey(erroredThread);

    expect(resolveMobileThreadStatus(erroredThread)).toMatchObject({
      bucket: "error",
      label: "Errored",
    });
    expect(
      resolveMobileThreadStatus(erroredThread, { "thread-error": dismissalKey ?? "" }),
    ).toMatchObject({
      bucket: "idle",
      label: "Idle",
    });
    expect(
      resolveMobileThreadStatus(erroredThread, { "thread-error": "stale-error-key" }),
    ).toMatchObject({
      bucket: "error",
      label: "Errored",
    });
  });
});
