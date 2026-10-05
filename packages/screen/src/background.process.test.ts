import { expect, it, onTestFinished } from "vitest";
import { ToolRegistry, CredentialRegistry } from "@ace/mcp-server";
import { McpScope } from "@ace/protocol";
import { screenToolkit, computerUseHandler } from "./index.ts";
import { allowForeground } from "./testing/foreground.ts";
import { manager, ready, target } from "./testing/support.ts";

it("eight apps have independent controllers, captures and stop lifetimes on one helper", async () => {
  const h = await manager({ FAKE_V2: "1", MULTI_TARGETS: "1" });
  onTestFinished(h.close);
  await h.screen.enable(true);
  const targets = Array.from({ length: 9 }, (_, index) => ({
    kind: "window" as const,
    windowId: index + 1,
    bundleId: index === 0 ? target.bundleId : `dev.ace.test${index + 1}`,
  }));
  for (const app of targets) await h.screen.approve(app.bundleId, true);
  const states = await Promise.all(targets.slice(0, 8).map((app) => h.screen.start(app)));
  for (const [index, state] of states.entries())
    h.screen.delegateAgent(state.sessionId, { threadId: "thread", agentId: `agent${index}` });
  await expect(h.screen.start(targets[8] ?? target)).rejects.toThrow("limit");
  const first = states[0],
    second = states[1];
  if (!first || !second) throw new Error("Missing sessions");
  await expect(h.screen.start(target)).rejects.toThrow(/target_busy.*agent0/);
  await expect(
    Promise.resolve().then(() =>
      h.screen.delegateAgent(first.sessionId, { threadId: "thread", agentId: "intruder" }),
    ),
  ).rejects.toThrow(/target_busy.*agent0/);
  await h.screen.input(
    first.sessionId,
    "agent",
    { kind: "text.type", text: "first" },
    JSON.stringify(["thread", "agent0"]),
  );
  const one = await h.screen.uiFind(first.sessionId, { query: { name: "Name" } });
  const two = await h.screen.uiFind(second.sessionId, { query: { name: "Name" } });
  expect(one.nodes[0]?.value).toBe("1");
  expect(two.nodes[0]?.value).toBe("0");
  const hostA = await h.screen.uiTree(first.sessionId, {});
  await h.screen.stop(first.sessionId);
  const hostB = await h.screen.uiTree(second.sessionId, {});
  expect(hostA.nodes[0]?.name).toBe(hostB.nodes[0]?.name);
  const frame = await h.screen.captureScreenshot(second.sessionId);
  expect(frame.header.sessionId).toBe(second.sessionId);
  expect(h.screen.state(second.sessionId)).toMatchObject({
    controller: "agent",
    mode: "background",
  });
  await h.screen.stopAll();
  expect(h.screen.states()).toEqual([]);
});

it("taking over one app cancels its queued actions while another agent keeps working", async () => {
  const h = await manager({ FAKE_V2: "1" });
  onTestFinished(h.close);
  const first = await ready(h.screen);
  const other = { ...target, bundleId: "dev.ace.other", windowId: 2 };
  await h.screen.approve(other.bundleId, true);
  const second = await h.screen.start(other);
  h.screen.controller(first.sessionId, "agent", "one");
  h.screen.controller(second.sessionId, "agent", "two");
  const action = h.screen.input(
    first.sessionId,
    "agent",
    { kind: "text.type", text: "queued" },
    "one",
  );
  h.screen.controller(first.sessionId, "human", "human");
  await expect(action).rejects.toThrow("Controller changed");
  const tool = computerUseHandler(h.screen, second.sessionId, "two");
  const result = await tool("screen_type", { text: "second" });
  expect(result.content[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining('"mode":"background"'),
  });
  expect(
    (await h.screen.uiFind(second.sessionId, { query: { name: "Name" } })).nodes[0]?.value,
  ).toBe("1");
});

it("secure text and ignored posted events fail without affecting the destination", async () => {
  const h = await manager({ FAKE_V2: "1", SECURE_TEXT: "1" });
  onTestFinished(h.close);
  const state = await ready(h.screen);
  h.screen.controller(state.sessionId, "agent", "agent");
  for (const kind of ["text.type", "text.paste"] as const)
    await expect(
      h.screen.input(state.sessionId, "agent", { kind, text: "secret" }, "agent"),
    ).rejects.toMatchObject({ code: "secure_input_required" });
  expect(
    (await h.screen.uiFind(state.sessionId, { query: { role: "AXSecureTextField" } })).nodes[0]
      ?.value,
  ).toBeUndefined();
  h.screen.secureInput(state.sessionId, true);
  await h.screen.input(state.sessionId, "agent", { kind: "text.type", text: "secret" }, "agent");
  h.screen.controller(state.sessionId, "human");
  expect(h.screen.state(state.sessionId).secureInputAllowed).toBe(false);
  const ignored = await manager({ FAKE_V2: "1", IGNORE_POSTED: "1" });
  onTestFinished(ignored.close);
  const app = await ready(ignored.screen);
  ignored.screen.controller(app.sessionId, "agent", "agent");
  await expect(
    ignored.screen.input(app.sessionId, "agent", { kind: "pointer.click", x: 5, y: 5 }, "agent"),
  ).rejects.toMatchObject({ code: "foreground_required" });
  expect(
    (await ignored.screen.uiFind(app.sessionId, { query: { name: "Name" } })).nodes[0]?.value,
  ).toBe("0");
});

it("MCP callers select only their delegated sessions and get a holder for a busy app", async () => {
  const h = await manager({ FAKE_V2: "1", MULTI_TARGETS: "1" });
  onTestFinished(h.close);
  const state = await ready(h.screen);
  h.screen.delegateAgent(state.sessionId, { threadId: "thread", agentId: "holder" });
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  screenToolkit(h.screen).register(registry);
  const credentials = new CredentialRegistry(() => "a".repeat(64));
  onTestFinished(() => credentials.close());
  const lease = credentials.issue(
    McpScope.parse({
      sessionId: "mcp",
      threadId: "thread",
      agentId: "other",
      capabilities: ["screen"],
    }),
    new AbortController().signal,
  );
  const busy = await registry.call(
    "screen_open_app",
    { bundleId: target.bundleId },
    lease.principal,
    new AbortController().signal,
  );
  expect(busy).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining('"holder"') }],
  });
  expect(
    await registry.call(
      "screen_ui_tree",
      { sessionId: state.sessionId },
      lease.principal,
      new AbortController().signal,
    ),
  ).toMatchObject({ isError: true });
});

it("stop all cancels an app still starting and blocks agent reacquisition until a human enables it", async () => {
  const h = await manager({ FAKE_V2: "1" });
  onTestFinished(h.close);
  await h.screen.enable(true);
  await h.screen.approve(target.bundleId, true);
  const starting = h.screen.start(target);
  const cancelled = expect(starting).rejects.toThrow();
  await h.screen.stopAll();
  await cancelled;
  expect(h.screen.states()).toEqual([]);
  await expect(
    h.screen.openAgentApp(
      target.bundleId,
      { threadId: "thread", agentId: "agent" },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "permission_denied" });
  await h.screen.enable(true);
  const state = await h.screen.openAgentApp(
    target.bundleId,
    { threadId: "thread", agentId: "agent" },
    new AbortController().signal,
  );
  expect(state).toMatchObject({ controller: "agent", mode: "background" });
});

it("opening a windowless app leaves a semantic session available to create its first window", async () => {
  const h = await manager({ FAKE_V2: "1", NO_WINDOWS: "1" });
  onTestFinished(h.close);
  await h.screen.enable(true);
  await h.screen.approve(target.bundleId, true);
  const state = await h.screen.openAgentApp(
    target.bundleId,
    { threadId: "thread", agentId: "agent" },
    new AbortController().signal,
  );
  expect(state.target).toEqual({ kind: "app", bundleId: target.bundleId });
  const result = await h.screen.uiTree(state.sessionId, {});
  expect(result.nodes[0]?.children.some((node) => node.name === "Click")).toBe(true);
});

it("wire errors include the busy holder while takeover is scoped to the selected app", async () => {
  const h = await manager({ FAKE_V2: "1" });
  onTestFinished(h.close);
  const state = await ready(h.screen);
  h.screen.delegateAgent(state.sessionId, { threadId: "thread", agentId: "root" });
  const messages: import("@ace/protocol").ScreenServerMessage[] = [];
  const { screenConnection, Simulators } = await import("./index.ts");
  const connection = screenConnection(h.screen, new Simulators("linux"), "human", {
    send: (message) => messages.push(message),
    frame: async () => {},
  });
  onTestFinished(() => connection.close());
  await connection.request({
    type: "screen.request",
    requestId: "busy",
    operation: { op: "start", target },
  });
  expect(messages.at(-1)).toMatchObject({
    type: "screen.result",
    ok: false,
    errorCode: "target_busy",
    holder: { sessionId: state.sessionId, owner: JSON.stringify(["thread", "root"]) },
  });
  await connection.request({
    type: "screen.request",
    requestId: "take",
    operation: { op: "controller", sessionId: state.sessionId, controller: "human" },
  });
  expect(h.screen.state(state.sessionId)).toMatchObject({
    controller: "human",
    mode: "background",
    secureInputAllowed: false,
  });
});

it("foreground consent allows otherwise ignored input and takeover resets that consent", async () => {
  const h = await manager({ FAKE_V2: "1", IGNORE_POSTED: "1" });
  onTestFinished(h.close);
  const state = await ready(h.screen);
  h.screen.controller(state.sessionId, "agent", "agent");
  await expect(
    h.screen.input(state.sessionId, "agent", { kind: "pointer.click", x: 5, y: 5 }, "agent"),
  ).rejects.toMatchObject({ code: "foreground_required" });
  expect(h.screen.state(state.sessionId).mode).toBe("background");
  await allowForeground(h.screen, state.sessionId);
  const tool = computerUseHandler(h.screen, state.sessionId, "agent");
  expect((await tool("screen_click", { x: 5, y: 5 })).content).toMatchObject([
    { text: expect.stringContaining('"mode":"foreground"') },
  ]);
  expect(
    (await h.screen.uiFind(state.sessionId, { query: { name: "Name" } })).nodes[0]?.value,
  ).toBe("1");
  h.screen.controller(state.sessionId, "human", "human");
  expect(h.screen.state(state.sessionId).mode).toBe("background");
});
