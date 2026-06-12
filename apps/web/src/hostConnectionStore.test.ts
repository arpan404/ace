import { ProjectId, ThreadId, type OrchestrationReadModel } from "@ace/contracts";
import { describe, expect, it } from "vitest";

import { useHostConnectionStore } from "./hostConnectionStore";

function resetHostConnectionStore(): void {
  useHostConnectionStore.setState({
    ownershipByConnectionUrl: {},
    projectConnectionById: {},
    threadConnectionById: {},
  });
}

function readModelWithOwnership(input: {
  projectIds?: ReadonlyArray<ProjectId>;
  threadIds?: ReadonlyArray<ThreadId>;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    projects: (input.projectIds ?? []).map((id) => ({
      id,
      archivedAt: null,
      deletedAt: null,
    })),
    threads: (input.threadIds ?? []).map((id) => ({
      id,
      archivedAt: null,
      deletedAt: null,
    })),
    updatedAt: new Date(0).toISOString(),
  } as unknown as OrchestrationReadModel;
}

describe("hostConnectionStore", () => {
  it("persists direct project ownership mappings", () => {
    resetHostConnectionStore();
    const store = useHostConnectionStore.getState();

    store.upsertProjectOwnership("ws://remote-host/ws", ProjectId.makeUnsafe("project-1"));

    const next = useHostConnectionStore.getState();
    expect(next.projectConnectionById["project-1"]).toBe("ws://remote-host/ws");
    expect(next.ownershipByConnectionUrl["ws://remote-host/ws"]?.projectIds).toContain("project-1");
  });

  it("persists direct thread ownership mappings", () => {
    resetHostConnectionStore();
    const store = useHostConnectionStore.getState();

    store.upsertThreadOwnership("ws://remote-host/ws", ThreadId.makeUnsafe("thread-1"));

    const next = useHostConnectionStore.getState();
    expect(next.threadConnectionById["thread-1"]).toBe("ws://remote-host/ws");
    expect(next.ownershipByConnectionUrl["ws://remote-host/ws"]?.threadIds).toContain("thread-1");
  });

  it("removes stale project ownership when a project moves to another connection", () => {
    resetHostConnectionStore();
    const projectId = ProjectId.makeUnsafe("project-1");

    useHostConnectionStore.getState().upsertProjectOwnership("ws://old-host/ws", projectId);
    useHostConnectionStore.getState().upsertProjectOwnership("ws://new-host/ws", projectId);

    const next = useHostConnectionStore.getState();
    expect(next.projectConnectionById[projectId]).toBe("ws://new-host/ws");
    expect(next.ownershipByConnectionUrl["ws://old-host/ws"]?.projectIds).not.toContain(projectId);
    expect(next.ownershipByConnectionUrl["ws://new-host/ws"]?.projectIds).toContain(projectId);
  });

  it("removes stale thread ownership when a thread moves to another connection", () => {
    resetHostConnectionStore();
    const threadId = ThreadId.makeUnsafe("thread-1");

    useHostConnectionStore.getState().upsertThreadOwnership("ws://old-host/ws", threadId);
    useHostConnectionStore.getState().upsertThreadOwnership("ws://new-host/ws", threadId);

    const next = useHostConnectionStore.getState();
    expect(next.threadConnectionById[threadId]).toBe("ws://new-host/ws");
    expect(next.ownershipByConnectionUrl["ws://old-host/ws"]?.threadIds).not.toContain(threadId);
    expect(next.ownershipByConnectionUrl["ws://new-host/ws"]?.threadIds).toContain(threadId);
  });

  it("merges stale snapshot ownership without dropping live-owned entities", () => {
    resetHostConnectionStore();
    const snapshotThreadId = ThreadId.makeUnsafe("thread-from-snapshot");
    const liveThreadId = ThreadId.makeUnsafe("thread-from-live-event");

    useHostConnectionStore.getState().upsertThreadOwnership("ws://remote-host/ws", liveThreadId);
    useHostConnectionStore
      .getState()
      .mergeSnapshotOwnership(
        "ws://remote-host/ws",
        readModelWithOwnership({ threadIds: [snapshotThreadId] }),
      );

    const next = useHostConnectionStore.getState();
    expect(next.threadConnectionById[snapshotThreadId]).toBe("ws://remote-host/ws");
    expect(next.threadConnectionById[liveThreadId]).toBe("ws://remote-host/ws");
    expect(next.ownershipByConnectionUrl["ws://remote-host/ws"]?.threadIds).toEqual([
      liveThreadId,
      snapshotThreadId,
    ]);
  });
});
