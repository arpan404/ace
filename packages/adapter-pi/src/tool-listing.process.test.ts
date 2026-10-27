import { expect, onTestFinished, test } from "vitest";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { AgentId, ThreadId } from "@ace/protocol";
import {
  CredentialRegistry,
  ToolRegistry,
  guideToolkit,
  nodeScheduler,
  privateMcpConfig,
  startMcpServer,
} from "@ace/mcp-server";
import { registerAcePiExtension } from "./index.ts";
import type { PiToolAnnotations } from "./extension-api.ts";
import { createPiExtensionHost } from "./testing/extension-host.ts";

/** A real ace MCP server with threads and agents families and their guides, under Pi's extension. */
async function piSession() {
  const registry = new ToolRegistry({ scheduler: nodeScheduler });
  const credentials = new CredentialRegistry(() => randomBytes(32).toString("hex"));
  registry.register({
    name: "threads_find",
    toolset: "ace-threads",
    description: "Find threads.",
    riskClass: "read-only",
    input: z.object({}),
    output: z.object({}),
    capability: null,
    timeoutMs: 1000,
    async run() {
      return {};
    },
  });
  registry.register({
    name: "thread_merge",
    toolset: "ace-threads",
    description: "Merge a thread's work.",
    riskClass: "thread-write",
    destructive: true,
    input: z.object({}),
    output: z.object({}),
    capability: null,
    timeoutMs: 1000,
    async run() {
      return {};
    },
  });
  registry.register({
    name: "delegate",
    description: "Start child agents.",
    riskClass: "agent-execution",
    input: z.object({}),
    output: z.object({}),
    capability: null,
    timeoutMs: 1000,
    async run() {
      return {};
    },
  });
  registry.register({
    name: "agents_status",
    toolset: "ace-agents",
    description: "Agent status.",
    input: z.object({}),
    output: z.object({}),
    capability: null,
    timeoutMs: 1000,
    async run() {
      return {};
    },
  });
  guideToolkit(
    ["ace-threads", "ace-agents"].map((name) => ({ name, description: name, body: name })),
  ).register(registry);
  const server = await startMcpServer({ registry, credentials });
  const lease = credentials.issue(
    {
      threadId: ThreadId.parse("thread"),
      agentId: AgentId.parse("agent"),
      sessionId: "session",
      capabilities: [],
    },
    new AbortController().signal,
  );
  const configuration = privateMcpConfig(
    JSON.stringify({
      controlSecret: "a".repeat(64),
      mcp: { url: server.url, bearer: lease.bearer },
    }),
  );
  const host = createPiExtensionHost({ activeTools: ["read", "bash"] });
  onTestFinished(async () => {
    await host.shutdown();
    lease.end();
    await server.close();
    configuration.remove();
  });
  await host.start((pi) => registerAcePiExtension(pi, { ACE_PI_SESSION_FILE: configuration.path }));
  expect(host.errors).toEqual([]);
  const tool = (name: string) => {
    const found = host.tools.get(name);
    if (!found) throw new Error(`Missing ${name}: ${host.active().join(",")}`);
    return found;
  };
  return { host, tool };
}

test("a family a guide or tools_call opens is declared to Pi before that call's result returns", async () => {
  const { host, tool } = await piSession();
  expect(host.active()).not.toContain("ace_threads_find");
  await tool("ace_guide").execute("guide", { topic: "ace-threads" }, undefined);
  // No wait for the list_changed notification: Pi's next model request already declares it.
  expect(host.active()).toContain("ace_threads_find");
  await tool("ace_tools_call").execute(
    "dispatch",
    { name: "guide", arguments: { topic: "ace-agents" } },
    undefined,
  );
  expect(host.active()).toContain("ace_agents_status");
  expect(host.active()).toEqual(expect.arrayContaining(["read", "bash"]));
});

test("Pi declares ace's tools to the model and never hands them to its codemode scripts", async () => {
  const { host } = await piSession();
  expect(host.active()).toEqual(
    expect.arrayContaining(["ace_context", "ace_guide", "ace_delegate"]),
  );
  // ace's tools are reached only as declared tools, so codemode never appends a script-call note
  // to their descriptions or hides them from the model.
  expect(host.scriptCallable().filter((name) => name.startsWith("ace_"))).toEqual([]);
});

test("a permission extension reading Pi's tool hints asks only before ace tools that overwrite work", async () => {
  const { host, tool } = await piSession();
  // The rule Pi's extension docs give for confirming the calls Codex asks about.
  const needsApproval = (hints: PiToolAnnotations | undefined) =>
    hints?.destructiveHint === true ||
    (!hints?.readOnlyHint && ((hints?.destructiveHint ?? true) || (hints?.openWorldHint ?? true)));
  expect(needsApproval(host.annotations("ace_guide"))).toBe(false);
  expect(needsApproval(host.annotations("ace_context"))).toBe(false);
  expect(needsApproval(host.annotations("ace_delegate"))).toBe(false);
  await tool("ace_guide").execute("guide", { topic: "ace-threads" }, undefined);
  expect(needsApproval(host.annotations("ace_thread_merge"))).toBe(true);
});
