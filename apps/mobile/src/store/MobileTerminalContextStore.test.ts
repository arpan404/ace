import type { QueuedComposerTerminalContext } from "@ace/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { useMobileTerminalContextStore } from "./MobileTerminalContextStore";

function makeContext(id: string): QueuedComposerTerminalContext {
  return {
    id: id as QueuedComposerTerminalContext["id"],
    createdAt: "2026-05-02T00:00:00.000Z" as QueuedComposerTerminalContext["createdAt"],
    terminalId: "mobile",
    terminalLabel: "Mobile terminal",
    lineStart: 1,
    lineEnd: 1,
    text: id,
  };
}

describe("useMobileTerminalContextStore", () => {
  beforeEach(() => {
    useMobileTerminalContextStore.setState({ contextsByThreadId: {} });
  });

  it("adds, removes, and clears thread contexts", () => {
    const store = useMobileTerminalContextStore.getState();
    store.addThreadContext("thread-1", makeContext("ctx-1"));
    store.addThreadContext("thread-1", makeContext("ctx-2"));

    expect(
      useMobileTerminalContextStore.getState().contextsByThreadId["thread-1"]?.map((c) => c.id),
    ).toEqual(["ctx-1", "ctx-2"]);

    useMobileTerminalContextStore.getState().removeThreadContext("thread-1", "ctx-1" as never);
    expect(
      useMobileTerminalContextStore.getState().contextsByThreadId["thread-1"]?.map((c) => c.id),
    ).toEqual(["ctx-2"]);

    useMobileTerminalContextStore.getState().clearThreadContexts("thread-1");
    expect(useMobileTerminalContextStore.getState().contextsByThreadId["thread-1"]).toBeUndefined();
  });

  it("bounds contexts per thread to the latest four", () => {
    for (const id of ["ctx-1", "ctx-2", "ctx-3", "ctx-4", "ctx-5"]) {
      useMobileTerminalContextStore.getState().addThreadContext("thread-1", makeContext(id));
    }

    expect(
      useMobileTerminalContextStore.getState().contextsByThreadId["thread-1"]?.map((c) => c.id),
    ).toEqual(["ctx-2", "ctx-3", "ctx-4", "ctx-5"]);
  });
});
