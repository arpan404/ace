import { ProjectId, ThreadId } from "@ace/contracts";
import { describe, expect, it } from "vitest";

import { useHostConnectionStore } from "./hostConnectionStore";

function resetHostConnectionStore(): void {
  useHostConnectionStore.setState({
    ownershipByConnectionUrl: {},
    projectConnectionById: {},
    threadConnectionById: {},
  });
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
});
