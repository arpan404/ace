import { expect, it } from "vitest";
import { stopDevice } from "./lifecycle.ts";
import { createSession } from "./session.ts";

const owner = {
  enabled: () => true,
  sessions: () => [],
  list: async () => [],
  emit: () => {},
  failure: () => ({ code: "command_failed" as const, message: "", hint: "" }),
  authorize: () => {},
  log: () => {},
};

it("a stop during a capture-only cleanup hands back control at once, before joining that cleanup", () => {
  const session = createSession(
    { id: "android:Pixel", name: "Pixel", platform: "android", state: "booted" },
    { now: () => 0, after: () => () => {} },
  );
  session.lease.claim({ kind: "agent", owner: "agent-1", threadId: "t1", agentId: "a1" });
  // The Android live view failed and its capture is still being torn down, keeping control.
  session.stopping = new Promise<void>(() => {});
  void stopDevice(session, owner);
  expect(session.lease.current()).toBeUndefined();
});
