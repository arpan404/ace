import { expect, it, onTestFinished } from "vitest";
import { CredentialRegistry, ToolRegistry } from "@ace/mcp-server";
import { McpScope } from "@ace/protocol";
import { screenToolkit } from "./index.ts";
import { manager, ready } from "./testing/support.ts";

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
