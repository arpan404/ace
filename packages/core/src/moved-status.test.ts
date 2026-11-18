import { HostId, ThreadId } from "@ace/protocol";
import { describe, expect, it } from "vitest";
import { deriveThreadStatus } from "./index.ts";
import { activeRoot, endedRoot } from "./status-test-helper.ts";

const to = { hostId: HostId.parse("studio"), name: "Studio", threadId: ThreadId.parse("t-there") };

describe("a thread whose work moved to another machine (ADR 0191)", () => {
  it("reads moved once its turn here has ended, never done", () => {
    const h = endedRoot();
    h.send({ type: "thread.moved", to });
    expect(deriveThreadStatus(h.state)).toEqual({ state: "moved", to });
  });

  it("still shows work that runs here as working", () => {
    const h = activeRoot();
    h.send({ type: "thread.moved", to });
    expect(deriveThreadStatus(h.state).state).toBe("working");
  });

  it("reads as it is again once the work runs here", () => {
    const h = endedRoot();
    h.send({ type: "thread.moved", to });
    h.send({ type: "thread.moved", to: null });
    expect(deriveThreadStatus(h.state)).toEqual({ state: "done" });
  });

  it("ignores a move with an incomplete destination", () => {
    const h = endedRoot();
    try {
      h.send({ type: "thread.moved", to: { ...to, name: "" } });
    } catch {
      /* A rejected fact may throw or be noted; either way nothing moves. */
    }
    expect(deriveThreadStatus(h.state)).toEqual({ state: "done" });
  });
});
