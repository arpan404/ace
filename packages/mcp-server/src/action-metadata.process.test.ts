import { afterEach, expect, test } from "vitest";
import { agentControlToolkit } from "./index.ts";
import { harness, scope } from "./test-support.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

test("a read-only MCP lease can call transcript reads and receives accurate tool hints", async () => {
  const h = await harness(cleanups);
  agentControlToolkit({
    async execute(_caller, operation) {
      return {
        ok: true,
        data:
          operation.op === "thread.read"
            ? { threadId: operation.threadId, retained: "child result" }
            : null,
      };
    },
  }).register(h.registry);
  const { client } = await h.connect();
  const tools = await client.listTools();
  expect(tools.tools.find((tool) => tool.name === "thread_read")).toMatchObject({
    title: "Read a thread",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  });
  expect(
    await client.callTool({ name: "thread_read", arguments: { threadId: "child" } }),
  ).toMatchObject({
    structuredContent: { ok: true, data: { threadId: "child", retained: "child result" } },
  });
  expect(tools.tools.some((tool) => tool.name === "delegate")).toBe(false);
  const agents = await h.connect(scope("parent", ["agents"]));
  expect(
    (await agents.client.listTools()).tools.find((tool) => tool.name === "delegate"),
  ).toMatchObject({
    annotations: { readOnlyHint: false },
    _meta: { "ace/timeoutMs": 630000, "ace/riskClass": "agent-execution" },
  });
});

test("only tools that delete or overwrite work are destructive; reads never ask", async () => {
  const h = await harness(cleanups);
  agentControlToolkit({
    async execute() {
      return { ok: true, data: null };
    },
  }).register(h.registry);
  const { client } = await h.connect(
    scope("root", ["thread_control", "automations", "agents", "projects"]),
  );
  const listed = (await client.listTools()).tools;
  const destructive = listed
    .filter((tool) => tool.annotations?.destructiveHint)
    .map((tool) => tool.name);
  expect(destructive).toEqual(["automation_remove"]);
  const hints = new Map(listed.map((tool) => [tool.name, tool.annotations]));
  expect(hints.get("automations_list")).toMatchObject({
    readOnlyHint: true,
    destructiveHint: false,
  });
  expect(hints.get("thread_control")).toMatchObject({
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  });
  // Every control tool acts on this machine's threads, so none reaches the open world.
  for (const tool of listed) {
    expect(tool.annotations?.openWorldHint, tool.name).toBe(false);
    expect(tool.title, tool.name).toBeTruthy();
    expect(tool.annotations?.title, tool.name).toBe(tool.title);
  }
});
