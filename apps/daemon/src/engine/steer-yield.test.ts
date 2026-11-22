import { describe, expect, test } from "vitest";
import { createThreadState } from "@ace/core";
import { AgentId, RunId, ThreadId, type Capabilities } from "@ace/protocol";
import { steerRoute } from "./steer-yield.ts";

const acpCapabilities: Capabilities = {
  permissionModes: [],
  permissions: { modes: [], permissionModes: [], nativeAutoReview: false, toolGate: true },
  steer: true,
  steeringMode: "interrupt-restart",
  interruptCascades: false,
  resume: true,
  fork: false,
  subagentTranscripts: false,
  backgroundTaskControl: false,
  backgroundVisibility: "partial",
  planMode: false,
  tokenUsage: false,
  imageInput: true,
  rewindFiles: false,
};

function threadState(activeRun?: string) {
  const threadId = ThreadId.parse("thread-1");
  const state = createThreadState({
    threadId,
    config: { provider: "antigravity", silenceMs: 1_000 },
  });
  state.rootKey = "root";
  state.agents["root"] = {
    agent: {
      id: AgentId.parse("agent-1"),
      threadId,
      parentId: null,
      origin: "root",
      native: { provider: "antigravity", nativeId: "native-1" },
      status: activeRun ? { state: "working", activity: "thinking" } : { state: "idle" },
      fidelity: "full",
      cwd: "/test",
      background: false,
      createdAt: 1,
    },
    ...(activeRun ? { activeRun: RunId.parse(activeRun) } : {}),
    activity: "thinking",
    lastSignalAt: 1,
  };
  return state;
}

describe("steerRoute for cancel-and-restart (ACP / Antigravity) sessions", () => {
  test("cancels the active turn when the person steers mid-turn", () => {
    expect(
      steerRoute({ person: true }, threadState("run-1"), acpCapabilities, undefined, {
        steerViaCancel: true,
      }),
    ).toBe("yield");
  });

  test("hands idle prompts to the sends lane so the steering lane stays free to cancel later turns", () => {
    expect(
      steerRoute({ person: true }, threadState(undefined), acpCapabilities, undefined, {
        steerViaCancel: true,
      }),
    ).toBeUndefined();
    expect(
      steerRoute(
        { person: true },
        threadState(undefined),
        acpCapabilities,
        { run: "run-1", state: "pending", intentId: 7 },
        { steerViaCancel: true },
      ),
    ).toBeUndefined();
  });

  test("waits while a cancel for the active run is already in flight or refused", () => {
    expect(
      steerRoute(
        { person: true },
        threadState("run-1"),
        acpCapabilities,
        { run: "run-1", state: "pending", intentId: 7 },
        { steerViaCancel: true },
      ),
    ).toBeUndefined();
    expect(
      steerRoute(
        { person: true },
        threadState("run-1"),
        acpCapabilities,
        { run: "run-1", state: "refused", intentId: 7 },
        { steerViaCancel: true },
      ),
    ).toBeUndefined();
  });

  test("never interrupts the active turn for non-person follow-ups", () => {
    expect(
      steerRoute({ person: false }, threadState("run-1"), acpCapabilities, undefined, {
        steerViaCancel: true,
      }),
    ).toBeUndefined();
  });
});
