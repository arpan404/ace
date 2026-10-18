import { expect, test } from "vitest";
import { z } from "zod";
import {
  AgentControlResult,
  AutomationResponse,
  ThreadId,
  maxMessageBytes,
  type Automation,
} from "@ace/protocol";
import { automationFixture } from "./automation-test-support.ts";
import { daemonFixture } from "./daemon-test-support.ts";

type Connection = { url: string; bearer: string };

/** One tool call over the daemon's real MCP HTTP endpoint, as a provider CLI makes it. */
async function callTool(connection: Connection, name: string, args: unknown) {
  const response = await fetch(connection.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.bearer}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  expect(response.status).toBe(200);
  return z
    .object({
      result: z.object({
        isError: z.boolean().optional(),
        content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
        structuredContent: AgentControlResult.optional(),
      }),
    })
    .parse(await response.json()).result;
}

const largeTask = (seed: string) => `${seed}\n${"x".repeat(100 * 1024)}`;

test("a delegated task of 100 KB reaches the child's first message", async () => {
  const f = await daemonFixture();
  try {
    const connection = f.h.contexts.get(f.caller.threadId)?.aceMcp;
    if (!connection) throw new Error("MCP connection missing");
    const task = largeTask("Review the attached log");
    const result = await callTool(connection, "delegate", {
      tasks: [{ requestId: "large-task", provider: "claude", task, role: "review-large-log" }],
    });
    expect(result.isError).not.toBe(true);
    const [child] = z
      .object({ threadIds: z.tuple([ThreadId]) })
      .parse(result.structuredContent?.data).threadIds;
    await f.daemon.engine?.flush();
    expect(f.h.inputs.get(child)?.[0]).toBe(`Role: review-large-log\n\nTask:\n${task}`);
  } finally {
    await f.daemon.close();
  }
});

test("a batch of 100 KB tasks starts every child with its whole task", async () => {
  const f = await daemonFixture();
  try {
    const connection = f.h.contexts.get(f.caller.threadId)?.aceMcp;
    if (!connection) throw new Error("MCP connection missing");
    const tasks = ["first", "second", "third"].map((name) => ({
      requestId: `batch-${name}`,
      provider: "claude",
      task: largeTask(name),
      role: name,
    }));
    const result = await callTool(connection, "delegate", { tasks });
    expect(result.isError).not.toBe(true);
    const children = z
      .object({ threadIds: z.array(ThreadId) })
      .parse(result.structuredContent?.data).threadIds;
    await f.daemon.engine?.flush();
    expect(children.map((child) => f.h.inputs.get(child)?.[0])).toEqual(
      tasks.map((task) => `Role: ${task.role}\n\nTask:\n${task.task}`),
    );
  } finally {
    await f.daemon.close();
  }
});

test("a task longer than a person's message is refused with the limit and starts nothing", async () => {
  const f = await daemonFixture();
  try {
    const connection = f.h.contexts.get(f.caller.threadId)?.aceMcp;
    if (!connection) throw new Error("MCP connection missing");
    const result = await callTool(connection, "delegate", {
      tasks: [
        {
          requestId: "too-long",
          provider: "claude",
          task: "x".repeat(maxMessageBytes + 1),
          role: "review-too-long-task",
        },
      ],
    });
    expect(result.isError).toBe(true);
    const failure = result.content.map((part) => part.text ?? "").join("");
    expect(failure).toContain("invalid_arguments");
    expect(failure).toContain("task");
    expect(failure).toContain(String(maxMessageBytes));
    await f.daemon.engine?.flush();
    expect(f.daemon.store.listThreads()).toHaveLength(1);
  } finally {
    await f.daemon.close();
  }
});

test("an agent's automation with a 100 KB prompt runs with the whole prompt", async () => {
  const f = await automationFixture();
  try {
    const prompt = largeTask("Summarize overnight failures");
    const automation: Automation = {
      id: "long-prompt",
      title: "Nightly",
      enabled: true,
      workspace: f.h.home,
      provider: "claude",
      prompt,
      worktree: false,
      trigger: { kind: "manual" },
      missedRun: "skip",
      concurrency: 1,
      jitterMs: 0,
    };
    expect(
      (
        await f.call({
          op: "automation.manage",
          request: { type: "automation.put", requestId: "put", automation },
        })
      ).ok,
    ).toBe(true);
    await f.settings.set("automations.enabled", true, { kind: "global" });
    await f.settings.settled({ kind: "global" });
    const admitted = AutomationResponse.parse(
      (
        await f.call({
          op: "automation.manage",
          request: { type: "automation.run", requestId: "run", id: automation.id, variables: {} },
        })
      ).data,
    );
    expect(admitted).toMatchObject({ ok: true, run: { status: "running" } });
    const runId = admitted.run?.id ?? "";
    await expect.poll(() => f.h.service.journal.receipt(f.caller.threadId, runId)).toBeDefined();
    await f.h.engine.flush();
    const child = f.h.service.journal.receipt(f.caller.threadId, runId)?.childId;
    if (!child) throw new Error("Missing automation child");
    expect(f.h.inputs.get(child)?.[0]).toBe(
      `Role: automation: ${automation.id}\n\nTask:\n${prompt}`,
    );
  } finally {
    await f.close();
  }
});
