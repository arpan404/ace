import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { CredentialRegistry, ToolRegistry } from "@ace/mcp-server";
import { McpScope } from "@ace/protocol";
import { computerUseTools, computerUseHandler, screenToolkit } from "./index.ts";
import { manager, ready } from "./testing/support.ts";

async function agentTools() {
  const test = await manager({ FAKE_V2: "1" });
  onTestFinished(test.close);
  const state = await ready(test.screen);
  const caller = { threadId: "thread", agentId: "agent" };
  test.screen.delegateAgent(state.sessionId, caller);
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  screenToolkit(test.screen).register(registry);
  const credentials = new CredentialRegistry(() => "a".repeat(64));
  onTestFinished(() => credentials.close());
  const lease = credentials.issue(
    McpScope.parse({ sessionId: "mcp", ...caller, capabilities: ["screen"] }),
    new AbortController().signal,
  );
  const call = (name: string, args: Record<string, unknown>) =>
    registry.call(name, args, lease.principal, new AbortController().signal);
  return { test, state, call };
}

it("the advertised input schema and handler accept the same bounded typing", async () => {
  const definition = computerUseTools.find((tool) => tool.name === "screen_input");
  if (!definition) throw new Error("Missing input tool");
  const input = z.fromJSONSchema(definition.inputSchema);
  const test = await manager({ FAKE_V2: "1" });
  onTestFinished(test.close);
  const state = await ready(test.screen);
  test.screen.controller(state.sessionId, "agent", "caller");
  const handler = computerUseHandler(test.screen, state.sessionId, "caller");
  const accepted = { action: "type", text: "x".repeat(4096) };
  expect(input.parse(accepted)).toEqual(accepted);
  await expect(handler("screen_input", accepted)).resolves.toMatchObject({
    content: [{ text: expect.stringContaining('"mode":"background"') }],
  });
  const rejected = { action: "type", text: "x".repeat(4097) };
  expect(() => input.parse(rejected)).toThrow();
  await expect(handler("screen_input", rejected)).rejects.toThrow();
});

it("input missing its action's fields, or carrying another action's, is refused before dispatch", async () => {
  const { test, state, call } = await agentTools();
  const click = await call("screen_input", { action: "click", text: "stray" });
  expect(click.isError).toBe(true);
  const failure = JSON.parse(String(click.content[0]?.type === "text" && click.content[0].text));
  expect(failure.code).toBe("invalid_arguments");
  expect(failure.issues.map((issue: { path: string }) => issue.path).toSorted()).toEqual([
    "text",
    "x",
    "y",
  ]);
  const typed = await call("screen_input", { action: "type", text: "dispatched" });
  expect(typed.isError).not.toBe(true);
  expect(
    (await test.screen.uiFind(state.sessionId, { query: { name: "Typed text" } })).nodes[0]?.value,
  ).toBe("dispatched");
});

it("a UI read with a query returns only the matching elements", async () => {
  const { call } = await agentTools();
  const text = (result: Awaited<ReturnType<typeof call>>) =>
    JSON.parse(String(result.content[0]?.type === "text" && result.content[0].text));
  const tree = text(await call("screen_ui_tree", {}));
  const found = text(await call("screen_ui_tree", { name: "Typed text" }));
  expect(found.nodes.length).toBeGreaterThan(0);
  expect(found.nodes.every((node: { name: string }) => node.name === "Typed text")).toBe(true);
  expect(JSON.stringify(tree.nodes)).not.toEqual(JSON.stringify(found.nodes));
});
