import { expect, it } from "vitest";
import { deriveAgentStatus } from "@ace/core";
import { replay } from "./translator-test-support.ts";

const status = (h: ReturnType<typeof replay>, at: number) => deriveAgentStatus(h.state, "root", at);

it("a replayed admission clears the send's wake instead of leaving a turn that never starts", () => {
  const h = replay();
  // The first send's turn finished; a reopen replays the same input's send and boundary.
  h.frame("result", { status: "finished" });
  const replayed = h.frame(
    "send",
    { input: [{ type: "text", text: "replayed input" }] },
    { dir: "send" },
  );
  expect(status(h, replayed.seq)).toEqual({ state: "working", activity: "starting_turn" });
  const admitted = h.frame("segment", { nativeRunId: "run-replayed" });
  expect(status(h, admitted.seq)).toEqual({ state: "idle" });
});

it("a replayed result for an earlier send leaves a pending send still starting", () => {
  const h = replay();
  h.frame("result", { status: "finished" });
  const pending = h.frame(
    "send",
    { input: [{ type: "text", text: "waiting for Cursor" }] },
    { operationId: "operation2", dir: "send" },
  );
  expect(status(h, pending.seq)).toEqual({ state: "working", activity: "starting_turn" });
  const replayed = h.frame("result", { status: "finished" }, { operationId: "operation1" });
  expect(status(h, replayed.seq)).toEqual({ state: "working", activity: "starting_turn" });
});
