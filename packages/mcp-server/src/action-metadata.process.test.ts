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
  expect(tools.tools.find((tool) => tool.name === "ace_thread_read")).toMatchObject({
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  });
  expect(
    await client.callTool({ name: "ace_thread_read", arguments: { threadId: "child" } }),
  ).toMatchObject({
    structuredContent: { ok: true, data: { threadId: "child", retained: "child result" } },
  });
  expect(tools.tools.some((tool) => tool.name === "delegate_task")).toBe(false);
  const agents = await h.connect(scope("parent", ["agents"]));
  expect(
    (await agents.client.listTools()).tools.find((tool) => tool.name === "delegate_task"),
  ).toMatchObject({
    annotations: { readOnlyHint: false },
    _meta: { "ace/timeoutMs": 300000, "ace/riskClass": "agent-execution" },
  });
});
