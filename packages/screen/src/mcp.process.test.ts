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

it("browser app requests refuse agent approval but accept a person's scoped UI grant", async () => {
  const h = await manager();
  onTestFinished(h.close);
  let approved = false;
  h.screen.configureAccess({
    enabled: () => true,
    enable() {},
    list: () =>
      approved
        ? [{ bundleId: "com.apple.Safari", scope: "thread", threadId: "thread", grantedAt: 1 }]
        : [],
    allows: (bundleId, caller) =>
      approved && bundleId === "com.apple.Safari" && caller?.threadId === "thread",
    approve(_bundleId, allowed) {
      approved = allowed;
    },
    async request() {
      throw new Error("An agent must never open browser approval");
    },
    async foreground() {},
    audit() {},
  });
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
  const request = () =>
    registry.call(
      "screen_request_app",
      { bundleId: "com.apple.Safari", reason: "Browse" },
      lease.principal,
      new AbortController().signal,
    );
  expect(await request()).toMatchObject({ isError: true });
  await expect(h.screen.approve("com.apple.Safari", true)).rejects.toMatchObject({
    code: "approval_required",
  });
  await h.screen.approve("com.apple.Safari", true, "thread", "thread");
  expect(await request()).not.toMatchObject({ isError: true });
  expect(h.screen.hasAppApproval({ threadId: "thread", agentId: "root" })).toBe(true);
  await h.screen.approve("com.apple.Safari", false, "thread", "thread");
  expect(await request()).toMatchObject({ isError: true });
});

it("MCP window selection returns the replacement session and keeps it usable", async () => {
  const h = await manager(
    { LEGACY_HELPER: "1" },
    { args: [new URL("./testing/fake-helper-behavior.ts", import.meta.url).pathname] },
  );
  onTestFinished(h.close);
  await h.screen.enable(true);
  await h.screen.approve(target.bundleId, true);
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
