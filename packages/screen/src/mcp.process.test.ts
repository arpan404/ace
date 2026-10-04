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
