import { afterEach, expect, test } from "vitest";
import { agentControlToolkit, cursorSdkInjection, knowledgeToolkit } from "./index.ts";
import { harness, scope } from "./test-support.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

/** The daemon side: records how long each blocking request was allowed to wait. */
async function daemon() {
  const h = await harness(cleanups);
  const waits: number[] = [];
  agentControlToolkit({
    async execute(_caller, operation) {
      if (operation.op === "wait") {
        waits.push(operation.timeoutSeconds);
        return { ok: true, data: { status: "timeout", mode: operation.mode, threads: [] } };
      }
      if (operation.op === "delegate_task") {
        if ("timeoutSeconds" in operation && typeof operation.timeoutSeconds === "number")
          waits.push(operation.timeoutSeconds);
        return { ok: true, data: { threadIds: ["child"] } };
      }
      return { ok: true, data: null };
    },
  }).register(h.registry);
  knowledgeToolkit({
    context: async () => ({}),
    addNote: async () => ({ noteId: "note-1", notes: 1 }),
    retireNote: async () => ({ retired: true }),
    async ask(_caller, input) {
      waits.push(input.timeoutSeconds);
      return { status: "pending", askId: "ask-1" };
    },
  }).register(h.registry);
  return { h, waits };
}

const cursorHeaders = () =>
  cursorSdkInjection({ url: "http://127.0.0.1:1/mcp", bearer: "b".repeat(64) }).mcpServers.ace
    .headers;

test("a Cursor session's waits end before Cursor's 60-second call limit cancels them", async () => {
  const { h, waits } = await daemon();
  const { Authorization: _, ...headers } = cursorHeaders();
  const { client } = await h.connect(scope("cursor-parent", ["agents"]), "modern", headers);
  await client.callTool({ name: "wait", arguments: { threadIds: ["child"], timeoutSeconds: 240 } });
  await client.callTool({ name: "wait", arguments: { threadIds: ["child"] } });
  await client.callTool({
    name: "delegate",
    arguments: {
      tasks: [{ requestId: "r1", role: "Review", task: "Review it" }],
      waitSeconds: 240,
    },
  });
  await client.callTool({ name: "ask", arguments: { question: "Which one?" } });
  expect(waits).toHaveLength(4);
  for (const seconds of waits) expect(seconds).toBeLessThan(60);
});

test("a client without a call limit keeps the wait it asked for", async () => {
  const { h, waits } = await daemon();
  const { client } = await h.connect(scope("claude-parent", ["agents"]));
  await client.callTool({ name: "wait", arguments: { threadIds: ["child"], timeoutSeconds: 240 } });
  await client.callTool({
    name: "ask",
    arguments: { question: "Which one?", timeoutSeconds: 200 },
  });
  expect(waits).toEqual([240, 200]);
});
