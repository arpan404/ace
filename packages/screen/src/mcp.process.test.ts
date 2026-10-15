import { expect, it, onTestFinished } from "vitest";
import { CredentialRegistry, ToolRegistry } from "@ace/mcp-server";
import { McpScope } from "@ace/protocol";
import { screenToolkit } from "./index.ts";
import { manager, ready, target } from "./testing/support.ts";

it("screen reads expose read-only approval actions and native actions remain effects", async () => {
  const h = await manager({ FAKE_V2: "1" });
  onTestFinished(h.close);
  await ready(h.screen);
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  screenToolkit(h.screen).register(registry);
  const credentials = new CredentialRegistry(() => "a".repeat(64));
  onTestFinished(() => credentials.close());
  const lease = credentials.issue(
    McpScope.parse({
      sessionId: "screen",
      threadId: "thread",
      agentId: "root",
      capabilities: ["screen"],
    }),
    new AbortController().signal,
  );
  expect(registry.action("screen_ui_tree", {})).toMatchObject({
    origin: "ace",
    riskClass: "read-only",
    access: "read",
  });
  expect(registry.action("screen_ui_act", { ref: "button", action: "press" })).toMatchObject({
    origin: "ace",
    riskClass: "external-effect",
    access: "write",
    description: expect.stringContaining("button"),
  });
  expect(
    registry.list(lease.principal).find((tool) => tool.name === "screen_ui_tree"),
  ).toMatchObject({ annotations: { readOnlyHint: true, destructiveHint: false } });
  expect(
    registry.list(lease.principal).find((tool) => tool.name === "screen_ui_act"),
  ).toMatchObject({ annotations: { readOnlyHint: false } });
});

it("an agent opens, types into and foregrounds any app, a web browser included, with no prompt", async () => {
  const h = await manager(
    {},
    { args: [new URL("./testing/fake-helper-behavior.ts", import.meta.url).pathname] },
  );
  onTestFinished(h.close);
  await h.screen.enable(true);
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  screenToolkit(h.screen).register(registry);
  const credentials = new CredentialRegistry(() => "a".repeat(64));
  onTestFinished(() => credentials.close());
  const lease = credentials.issue(
    McpScope.parse({
      sessionId: "mcp",
      threadId: "thread",
      agentId: "root",
      capabilities: ["screen"],
    }),
    new AbortController().signal,
  );
  const call = (name: string, args: Record<string, unknown>) =>
    registry.call(name, args, lease.principal, new AbortController().signal);
  for (const [name, args] of [
    ["screen_open_app", { bundleId: "com.apple.Safari" }],
    ["screen_type", { text: "release notes" }],
    ["screen_request_foreground", {}],
  ] as const) {
    const result = await call(name, args);
    expect(result.isError, `${name}: ${JSON.stringify(result.content)}`).not.toBe(true);
  }
  expect(h.screen.states()).toMatchObject([
    {
      target: { bundleId: "com.apple.Safari" },
      controller: "agent",
      holder: { threadId: "thread", agentId: "root" },
      mode: "foreground",
    },
  ]);
});

it("MCP window selection returns the replacement session and keeps it usable", async () => {
  const h = await manager(
    { LEGACY_HELPER: "1" },
    { args: [new URL("./testing/fake-helper-behavior.ts", import.meta.url).pathname] },
  );
  onTestFinished(h.close);
  await h.screen.enable(true);
  const caller = { threadId: "thread", agentId: "root" };
  const state = await h.screen.openAgentApp(
    target.bundleId,
    caller,
    new AbortController().signal,
    1,
  );
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  screenToolkit(h.screen).register(registry);
  const credentials = new CredentialRegistry(() => "a".repeat(64));
  onTestFinished(() => credentials.close());
  const lease = credentials.issue(
    McpScope.parse({ sessionId: "mcp", ...caller, capabilities: ["screen"] }),
    new AbortController().signal,
  );
  const result = await registry.call(
    "screen_select_window",
    { sessionId: state.sessionId, windowId: 2 },
    lease.principal,
    new AbortController().signal,
  );
  expect(result.isError).not.toBe(true);
  expect(result["_meta"]).toMatchObject({
    "ace/screen": { sessionId: h.screen.agentSession(caller) },
  });
  expect(h.screen.agentSession(caller)).not.toBe(state.sessionId);
  const typed = await registry.call(
    "screen_type",
    { sessionId: h.screen.agentSession(caller), text: "replacement works" },
    lease.principal,
    new AbortController().signal,
  );
  expect(typed.isError).not.toBe(true);
});
