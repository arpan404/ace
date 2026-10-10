import { expect, it, onTestFinished } from "vitest";
import { ToolRegistry, CredentialRegistry } from "@ace/mcp-server";
import { McpScope } from "@ace/protocol";
import { computerUseHandler, screenToolkit } from "./index.ts";
import { manager, ready, target } from "./testing/support.ts";
import { helperGate } from "./testing/gate.ts";
const fixtureArgs = [new URL("./testing/fake-helper-behavior.ts", import.meta.url).pathname];
async function fixture(env: NodeJS.ProcessEnv = {}) {
  const h = await manager(env, { args: fixtureArgs });
  onTestFinished(h.close);
  return h;
}
const caller = { threadId: "thread", agentId: "agent" };
it("opening an app selects its focused usable window and lists alternatives", async () => {
  const h = await fixture({ NOT_READY_QUERIES: "2" });
  await h.screen.enable(true);
  await h.screen.approve(target.bundleId, true);
  const state = await h.screen.openAgentApp(target.bundleId, caller, new AbortController().signal);
  expect(state.target).toEqual({ kind: "window", bundleId: target.bundleId, windowId: 2 });
  expect(state.windows.map((window) => window.windowId)).toEqual([1, 2]);
  const tools = computerUseHandler(
    h.screen,
    state.sessionId,
    JSON.stringify([caller.threadId, caller.agentId]),
  );
  await tools("screen_select_window", { windowId: 1 });
  expect(h.screen.state(state.sessionId).target).toEqual(target);
  await expect(tools("screen_select_window", { windowId: 99 })).rejects.toMatchObject({
    code: "target_gone",
  });
  expect(h.screen.state(state.sessionId).target).toEqual(target);
});
it("ambiguous app acquisition reports candidate windows before dispatch", async () => {
  const h = await fixture({ AMBIGUOUS: "1" });
  await h.screen.enable(true);
  await h.screen.approve(target.bundleId, true);
  await expect(
    h.screen.openAgentApp(target.bundleId, caller, new AbortController().signal),
  ).rejects.toMatchObject({
    code: "window_ambiguous",
    phase: "rejected-before-dispatch",
    candidates: [{ windowId: 1, bounds: { x: 0, y: 0, w: 100, h: 100 } }, { windowId: 2 }],
  });
  expect(h.screen.states()).toEqual([]);
  const selected = await h.screen.openAgentApp(
    target.bundleId,
    caller,
    new AbortController().signal,
    1,
  );
  expect(selected.target).toEqual(target);
});
it.each(["text.type", "text.paste"] as const)(
  "a held background %s in one app does not block another app or its observations",
  async (kind) => {
    const gate = await helperGate();
    onTestFinished(gate.close);
    const h = await fixture({ ACTION_GATE_PORT: gate.port });
    const first = await ready(h.screen);
    const other = "dev.ace.other";
    await h.screen.approve(other, true);
    const second = await h.screen.start({ ...target, bundleId: other });
    h.screen.controller(first.sessionId, "agent", "agent");
    h.screen.controller(second.sessionId, "agent", "agent");
    const held = h.screen.input(first.sessionId, "agent", { kind, text: "held" }, "agent");
    await gate.reached;
    try {
      await h.screen.input(second.sessionId, "agent", { kind, text: "independent" }, "agent");
      expect((await h.screen.uiTree(second.sessionId, {})).nodes[0]?.value).toBe("independent");
    } finally {
      gate.release();
      await held;
    }
    expect((await h.screen.uiTree(first.sessionId, {})).nodes[0]?.value).toBe("held");
  },
);
it.each([
  "window_ambiguous",
  "key_unsupported",
  "modifier_unsupported",
  "no_key_window",
  "delivery_unconfirmed",
])("authored %s and its dispatch phase reach the agent", async (code) => {
  const h = await fixture({ AUTHORED_ERROR: code, DISPATCH_PHASE: "partial" });
  const state = await ready(h.screen);
  h.screen.delegateAgent(state.sessionId, caller);
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  screenToolkit(h.screen).register(registry);
  const credentials = new CredentialRegistry(() => "a".repeat(64));
  onTestFinished(() => credentials.close());
  const lease = credentials.issue(
    McpScope.parse({ sessionId: "mcp", ...caller, capabilities: ["screen"] }),
    new AbortController().signal,
  );
  const result = await registry.call(
    "screen_key",
    { key: "l", modifiers: ["command"] },
    lease.principal,
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining(`"code":"${code}"`) }],
  });
  expect(result.content).toMatchObject([{ text: expect.stringContaining('"phase":"partial"') }]);
  if (code === "window_ambiguous")
    expect(result.content).toMatchObject([
      {
        text: expect.stringContaining('"candidates":[{"windowId":2}]'),
      },
    ]);
});
it("action tools reuse one settled traversal and cached permission facts", async () => {
  const recorded = await manager({}, { args: fixtureArgs });
  onTestFinished(recorded.close);
  const state = await ready(recorded.screen);
  recorded.screen.controller(state.sessionId, "agent", "agent");
  const tools = computerUseHandler(recorded.screen, state.sessionId, "agent");
  for (const [name, args] of [
    ["screen_type", { text: "typed" }],
    ["screen_key", { key: "l", modifiers: ["command"] }],
    ["screen_paste", { text: "pasted" }],
    ["screen_menu", { path: ["File", "New"] }],
    ["screen_open_url", { url: "https://example.test/" }],
  ] as const) {
    const result = await tools(name, args);
    expect(result.content).toMatchObject([
      { text: expect.stringContaining('"snapshot":{"nodes"') },
    ]);
  }
  expect((await recorded.screen.uiTree(state.sessionId, {})).nodes[0]?.value).toBe(
    "https://example.test/",
  );
});
it("TCC change events revoke cached permission before the next action", async () => {
  const h = await fixture();
  const state = await ready(h.screen);
  h.screen.controller(state.sessionId, "agent", "agent");
  await expect(
    h.screen.input(state.sessionId, "agent", { kind: "text.type", text: "revoke" }, "agent"),
  ).rejects.toMatchObject({ code: "permission_denied" });
  await expect(
    h.screen.input(state.sessionId, "agent", { kind: "text.type", text: "must not type" }, "agent"),
  ).rejects.toMatchObject({ code: "permission_denied" });
  expect((await h.screen.uiTree(state.sessionId, {})).nodes[0]?.value).toBe("");
});

it("a late permission inspection cannot overwrite a newer TCC revocation", async () => {
  const h = await fixture({ REVOKE_DURING_QUERY: "1" });
  const state = await ready(h.screen);
  expect(state.permissions.accessibility).toBe(false);
  h.screen.controller(state.sessionId, "agent", "agent");
  await expect(
    h.screen.input(state.sessionId, "agent", { kind: "text.type", text: "must not type" }, "agent"),
  ).rejects.toMatchObject({ code: "permission_denied" });
  expect((await h.screen.uiTree(state.sessionId, {})).nodes[0]?.value).toBe("");
});

it("helpers without a window resolver report ambiguity and accept an explicit acquisition", async () => {
  const h = await fixture({ LEGACY_HELPER: "1" });
  await h.screen.enable(true);
  await h.screen.approve(target.bundleId, true);
  await expect(
    h.screen.openAgentApp(target.bundleId, caller, new AbortController().signal),
  ).rejects.toMatchObject({ code: "window_ambiguous" });
  const selected = await h.screen.openAgentApp(
    target.bundleId,
    caller,
    new AbortController().signal,
    1,
  );
  expect(selected.target).toEqual(target);
  const switched = await h.screen.selectWindow(
    selected.sessionId,
    2,
    JSON.stringify([caller.threadId, caller.agentId]),
    () => {},
  );
  expect(switched.target).toEqual({ ...target, windowId: 2 });
  expect(h.screen.agentSession(caller)).toBe(switched.sessionId);
  expect(h.screen.states()).toHaveLength(1);
});
it("helpers without permission events recheck revocation before another input dispatch", async () => {
  const h = await fixture({ LEGACY_HELPER: "1" });
  const state = await ready(h.screen);
  h.screen.controller(state.sessionId, "agent", "agent");
  await h.screen.input(
    state.sessionId,
    "agent",
    { kind: "text.type", text: "revoke-silent" },
    "agent",
  );
  await expect(
    h.screen.input(state.sessionId, "agent", { kind: "text.type", text: "must not type" }, "agent"),
  ).rejects.toMatchObject({ code: "permission_denied" });
  expect((await h.screen.uiTree(state.sessionId, {})).nodes[0]?.value).toBe("revoke-silent");
});
