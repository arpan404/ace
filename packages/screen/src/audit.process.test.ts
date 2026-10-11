import { expect, it, onTestFinished } from "vitest";
import { readdir } from "node:fs/promises";
import { Helper, screenConnection, Simulators } from "./index.ts";
import { manager, ready, ids, target } from "./testing/support.ts";
import { helperGate } from "./testing/gate.ts";
import type { ScreenAccess } from "./access.ts";

const caller = { threadId: "thread", agentId: "agent" };
const owner = JSON.stringify([caller.threadId, caller.agentId]);
const args = [new URL("./testing/fake-helper-behavior.ts", import.meta.url).pathname];
async function fixture(env: NodeJS.ProcessEnv = {}) {
  const h = await manager(env, { args });
  onTestFinished(h.close);
  return h;
}
function access(currentTurn: () => string | undefined): ScreenAccess {
  return {
    currentTurn,
    enabled: () => true,
    enable() {},
    list: () => [],
    allows: () => true,
    approve() {},
    async request() {},
    async foreground() {},
    audit() {},
  };
}

it("a released app can be reacquired by an approved agent without retaining the old reservation", async () => {
  const h = await fixture();
  await ready(h.screen);
  // The human-created session has no owner and can be acquired.
  const first = await h.screen.openAgentApp(target.bundleId, caller, new AbortController().signal);
  h.screen.releaseController(owner);
  const next = await h.screen.openAgentApp(target.bundleId, caller, new AbortController().signal);
  expect(next.sessionId).not.toBe(first.sessionId);
  expect(h.screen.states()).toHaveLength(1);
  await h.screen.input(next.sessionId, "agent", { kind: "text.type", text: "reacquired" }, owner);
  expect((await h.screen.uiTree(next.sessionId, {})).nodes[0]?.value).toBe("reacquired");
});

it("a request timeout leaves independent sessions usable and ignores its late reply", async () => {
  const gate = await helperGate();
  onTestFinished(gate.close);
  const deadlines = new Set<() => void>();
  const failures: Error[] = [];
  const helper = await Helper.open({
    command: process.execPath,
    args,
    env: { GATE_OP: "ui.tree", GATE_PORT: gate.port },
    nextId: ids(),
    onFrame() {},
    onFailure: (error) => failures.push(error),
    scheduler: {
      schedule(callback) {
        deadlines.add(callback);
        return () => {
          deadlines.delete(callback);
        };
      },
    },
  });
  onTestFinished(async () => {
    gate.release();
    await helper.close();
  });
  await helper.negotiate();
  for (const sessionId of ["a", "b"])
    await helper.request({ op: "start", sessionId, target, fps: 10, allowlist: [target.bundleId] });
  const slow = expect(
    helper.request({
      op: "ui.tree",
      maxDepth: 2,
      maxNodes: 8,
      sessionId: "a",
      target,
      allowlist: [target.bundleId],
    }),
  ).rejects.toMatchObject({ code: "timeout" });
  await gate.reached;
  for (const expire of deadlines) expire();
  await slow;
  await helper.request({
    op: "input",
    sessionId: "b",
    input: { kind: "text.type", text: "survives" },
  });
  gate.release();
  const observed = await helper.request({
    op: "ui.find",
    sessionId: "b",
    target,
    allowlist: [target.bundleId],
    query: { role: "AXTextField" },
    limit: 8,
  });
  expect(observed).toMatchObject({ nodes: [{ value: "survives" }] });
  expect(failures).toEqual([]);
});

it("a failed capture releases its app and does not end another app session", async () => {
  const h = await fixture();
  await h.screen.enable(true);
  await h.screen.approve(target.bundleId, true);
  const first = await h.screen.openAgentApp(target.bundleId, caller, new AbortController().signal);
  await h.screen.approve("dev.ace.other", true);
  const second = await h.screen.start({ ...target, bundleId: "dev.ace.other" });
  h.screen.delegateAgent(second.sessionId, caller);
  // A fake native failure is sent from the same stdout boundary as real capture failures.
  await h.screen.input(
    first.sessionId,
    "agent",
    { kind: "text.type", text: "fail-session" },
    owner,
  );
  await h.screen.currentPermissions();
  const next = await h.screen.openAgentApp(target.bundleId, caller, new AbortController().signal);
  expect(next.sessionId).not.toBe(first.sessionId);
  await h.screen.input(
    second.sessionId,
    "agent",
    { kind: "text.type", text: "other survives" },
    owner,
  );
  expect((await h.screen.uiTree(second.sessionId, {})).nodes[0]?.value).toBe("other survives");
});

it.each([undefined, "next-turn"])(
  "foreground consent expires when the approved turn changes to %s",
  async (nextTurn) => {
    const h = await fixture();
    const state = await ready(h.screen);
    h.screen.delegateAgent(state.sessionId, caller);
    let turn: string | undefined = "turn";
    h.screen.configureAccess(access(() => turn));
    await h.screen.mode(state.sessionId, "foreground");
    expect(h.screen.state(state.sessionId).mode).toBe("foreground");
    turn = nextTurn;
    await h.screen.revalidate();
    await h.screen.input(
      state.sessionId,
      "agent",
      { kind: "text.type", text: "background" },
      owner,
    );
    expect(h.screen.state(state.sessionId).mode).toBe("background");
    expect((await h.screen.uiTree(state.sessionId, {})).nodes[0]?.value).toBe("background");
  },
);

it("status and permission inspections can finish while an app launch is still pending", async () => {
  const gate = await helperGate();
  onTestFinished(gate.close);
  const h = await fixture({ GATE_OP: "open.app", GATE_PORT: gate.port });
  await h.screen.enable(true);
  await h.screen.approve(target.bundleId, true);
  const opening = h.screen.openAgentApp(target.bundleId, caller, new AbortController().signal);
  await gate.reached;
  try {
    expect(await h.screen.currentPermissions()).toEqual({
      screenRecording: true,
      accessibility: true,
    });
  } finally {
    gate.release();
  }
  const state = await opening;
  await h.screen.input(state.sessionId, "agent", { kind: "text.type", text: "launched" }, owner);
  expect((await h.screen.uiTree(state.sessionId, {})).nodes[0]?.value).toBe("launched");
});

it("disabled status does not start a helper", async () => {
  const h = await manager({}, { command: "/no/such/screen-helper", args: [] });
  onTestFinished(h.close);
  expect(await h.screen.currentPermissions()).toEqual({
    screenRecording: false,
    accessibility: false,
  });
});

it("observe-only measurement refuses another agent and a human-controlled session", async () => {
  const h = await fixture();
  const state = await ready(h.screen);
  h.screen.delegateAgent(state.sessionId, caller);
  expect(() =>
    h.screen.measurementSession({ ...caller, threadId: "other" }, state.sessionId),
  ).toThrow();
  await expect(
    h.screen.measureInteraction(
      state.sessionId,
      { observeMs: 100 },
      JSON.stringify(["other", "agent"]),
      new AbortController().signal,
    ),
  ).rejects.toThrow("another controller");
  h.screen.controller(state.sessionId, "human", "person");
  expect(() => h.screen.measurementSession(caller, state.sessionId)).toThrow();
  h.screen.releaseController("person");
  expect(h.screen.measurementSession(caller, state.sessionId)).toBe(state.sessionId);
});

it("stop all terminates every capture even when an external controller release fails", async () => {
  const h = await fixture();
  const first = await ready(h.screen);
  await h.screen.approve("dev.ace.other", true);
  const second = await h.screen.start({ ...target, bundleId: "dev.ace.other" });
  h.screen.controller(first.sessionId, "human", "person", {
    authorize() {},
    released() {
      throw new Error("release failed");
    },
  });
  h.screen.controller(second.sessionId, "agent", "agent");
  await expect(h.screen.stopAll()).rejects.toThrow();
  expect(h.screen.isEnabled()).toBe(false);
  expect(h.screen.states()).toEqual([]);
});

it("delegation without a thread fails without creating an unusable controller", async () => {
  const h = await fixture();
  const state = await ready(h.screen);
  let result: unknown;
  const connection = screenConnection(h.screen, new Simulators("linux"), "person", {
    send: (message) => {
      result = message;
    },
    frame: async () => {},
  });
  onTestFinished(() => connection.close());
  await connection.request({
    type: "screen.request",
    requestId: "delegate",
    operation: {
      op: "controller",
      sessionId: state.sessionId,
      controller: "agent",
      agentId: "agent",
    },
  });
  expect(result).toMatchObject({ ok: false });
  expect(h.screen.state(state.sessionId).controller).toBe("none");
});

it("a cancelled recording start removes its file without publishing an artifact", async () => {
  const published: unknown[] = [];
  const h = await manager(
    {},
    {
      args,
      publishArtifact: async (artifact) => {
        published.push(artifact);
      },
    },
  );
  onTestFinished(h.close);
  const state = await ready(h.screen);
  const starting = expect(h.screen.startRecording(state.sessionId)).rejects.toThrow("cancelled");
  await h.screen.stop(state.sessionId);
  await starting;
  expect(await readdir(h.directory)).toEqual([]);
  expect(published).toEqual([]);
});

it("disabling returns a stop failure instead of waiting forever for an unconfirmed capture", async () => {
  const h = await fixture({ STOP_ERROR: "1" });
  await ready(h.screen);
  await expect(h.screen.enable(false)).rejects.toThrow("stop rejected");
  expect(h.screen.isEnabled()).toBe(false);
  expect(h.screen.states()).toEqual([]);
});

it("frame fan-out reuses authorization until access is revalidated", async () => {
  const h = await fixture();
  const state = await ready(h.screen);
  h.screen.delegateAgent(state.sessionId, caller);
  let allowed = true;
  let budget = Infinity;
  h.screen.configureAccess({
    ...access(() => "turn"),
    allows() {
      if (--budget < 0) throw new Error("Authorization I/O budget exceeded");
      return allowed;
    },
  });
  const received = Promise.withResolvers<void>();
  h.screen.subscribe(state.sessionId, async (frame) => {
    if (frame.payload.toString() === "frame-15") received.resolve();
  });
  await h.screen.input(
    state.sessionId,
    "agent",
    { kind: "text.type", text: "frames" },
    owner,
    () => {
      budget = 2;
    },
  );
  await received.promise;
  expect(h.screen.state(state.sessionId).lifecycle).toBe("live");
  budget = Infinity;
  allowed = false;
  await h.screen.revalidate();
  expect(h.screen.states()).toEqual([]);
});

it("starting a target replaces an ownerless capture instead of treating its app as busy", async () => {
  const h = await fixture();
  const first = await ready(h.screen);
  const second = await h.screen.start(target);
  expect(second.sessionId).not.toBe(first.sessionId);
  expect(h.screen.states()).toEqual([second]);
});

it("an ended root run expires foreground even while its tree still keeps the turn alive", async () => {
  const h = await fixture();
  const state = await ready(h.screen);
  h.screen.delegateAgent(state.sessionId, caller);
  h.screen.configureAccess(access(() => "turn"));
  await h.screen.mode(state.sessionId, "foreground");
  h.screen.turnEnded(caller.threadId, "other-run");
  expect(h.screen.state(state.sessionId).mode).toBe("foreground");
  h.screen.turnEnded(caller.threadId, "turn");
  expect(h.screen.state(state.sessionId).mode).toBe("background");
});
