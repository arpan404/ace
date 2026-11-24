import { describe, expect, test } from "vitest";
import { apply, createThreadState, type Fact } from "@ace/core";
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

  test("waits while the root runs a command, since the agent's cancel would kill it", () => {
    const state = threadState("run-1");
    let ids = 0;
    const send = (fact: Fact) => apply(state, fact, { now: 1, ids: { next: () => `id-${++ids}` } });
    const command = (status: "running" | "succeeded") =>
      send({
        type: "item.upsert",
        agent: "root",
        item: "command",
        draft: {
          type: "tool_call",
          complete: status === "succeeded",
          call: {
            kind: "shell",
            title: "bun run dev",
            status,
            detail: { kind: "shell", command: "bun run dev" },
          },
        },
      });
    command("running");
    expect(
      steerRoute({ person: true }, state, acpCapabilities, undefined, { steerViaCancel: true }),
    ).toBeUndefined();
    command("succeeded");
    expect(
      steerRoute({ person: true }, state, acpCapabilities, undefined, { steerViaCancel: true }),
    ).toBe("yield");
  });

  test("waits while a child agent runs a command, since cancelling the root would kill it", () => {
    const state = threadState("run-1");
    const root = state.agents["root"];
    if (!root) throw new Error("Expected a root agent");
    state.agents["child"] = {
      agent: {
        id: AgentId.parse("agent-2"),
        threadId: state.threadId,
        parentId: root.agent.id,
        origin: "provider_subagent",
        native: { provider: "antigravity", nativeId: "native-2" },
        status: { state: "working", activity: "tool" },
        fidelity: "full",
        cwd: "/test",
        background: false,
        createdAt: 1,
      },
      parentKey: "root",
      activity: "tool",
      lastSignalAt: 1,
    };
    let ids = 0;
    const send = (fact: Fact) => apply(state, fact, { now: 1, ids: { next: () => `id-${++ids}` } });
    const command = (status: "running" | "succeeded") =>
      send({
        type: "item.upsert",
        agent: "child",
        item: "child-command",
        draft: {
          type: "tool_call",
          complete: status === "succeeded",
          call: {
            kind: "shell",
            title: "bun run dev",
            status,
            detail: { kind: "shell", command: "bun run dev" },
          },
        },
      });
    command("running");
    expect(
      steerRoute({ person: true }, state, acpCapabilities, undefined, { steerViaCancel: true }),
    ).toBeUndefined();
    command("succeeded");
    expect(
      steerRoute({ person: true }, state, acpCapabilities, undefined, { steerViaCancel: true }),
    ).toBe("yield");
  });
});
