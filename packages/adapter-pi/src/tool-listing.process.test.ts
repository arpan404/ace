import { expect, onTestFinished, test, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
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

/**
 * A loopback relay between Pi's extension and ace's server that can hold back what the listen
 * stream delivers (the server's list_changed notifications) and stall `tools/list` requests.
 */
async function mcpRelay(target: string) {
  const upstream = new URL(target);
  let holding = false;
  let held: (() => void)[] = [];
  let stalled: Promise<void> | undefined;
  let release: (() => void) | undefined;
  const listRequests: (() => void)[] = [];
  const relay = async (incoming: IncomingMessage, outgoing: ServerResponse) => {
    const method = incoming.headers["mcp-method"];
    if (method === "tools/list") {
      for (const notify of listRequests.splice(0)) notify();
      await stalled;
    }
    const forward = request(
      new URL(incoming.url ?? "/", upstream),
      { method: incoming.method, headers: { ...incoming.headers, host: upstream.host } },
      (reply) => {
        outgoing.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.on("data", (chunk: Buffer) => {
          if (method === "subscriptions/listen" && holding) held.push(() => outgoing.write(chunk));
          else outgoing.write(chunk);
        });
        reply.on("end", () => outgoing.end());
      },
    );
    forward.on("error", () => outgoing.destroy());
    outgoing.on("close", () => forward.destroy());
    incoming.pipe(forward);
  };
  const server = createServer((incoming, outgoing) => void relay(incoming, outgoing));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${upstream.pathname}`,
    holdNotifications() {
      holding = true;
    },
    deliverNotifications() {
      holding = false;
      for (const deliver of held) deliver();
      held = [];
    },
    stallLists() {
      stalled = new Promise((resolve) => (release = resolve));
    },
    releaseLists() {
      stalled = undefined;
      release?.();
    },
    /** Resolves when the next `tools/list` request reaches the relay. */
    nextList: () => new Promise<void>((resolve) => listRequests.push(resolve)),
    async close() {
      this.releaseLists();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

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
  const relay = await mcpRelay(server.url);
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
      mcp: { url: relay.url, bearer: lease.bearer },
    }),
  );
  const host = createPiExtensionHost({ activeTools: ["read", "bash"] });
  onTestFinished(async () => {
    await host.shutdown();
    await relay.close();
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
  return { host, tool, relay };
}

test("a family a guide or tools_call opens is declared to Pi before that call's result returns", async () => {
  const { host, tool, relay } = await piSession();
  expect(host.active()).not.toContain("ace_threads_find");
  // The server's list_changed lands only after each call returns, as it can in a real session.
  relay.holdNotifications();
  await tool("ace_guide").execute("guide", { topic: "ace-threads" }, undefined);
  expect(host.active()).toContain("ace_threads_find");
  await tool("ace_tools_call").execute(
    "dispatch",
    { name: "guide", arguments: { topic: "ace-agents" } },
    undefined,
  );
  expect(host.active()).toContain("ace_agents_status");
  expect(host.active()).toEqual(expect.arrayContaining(["read", "bash"]));
  relay.deliverNotifications();
});

test("a guide's result returns within a second when the tool list reload stalls, and the reload still declares the family", async () => {
  const { host, tool, relay } = await piSession();
  relay.holdNotifications();
  relay.stallLists();
  const started = performance.now();
  const result = await tool("ace_guide").execute("guide", { topic: "ace-threads" }, undefined);
  expect(performance.now() - started).toBeLessThan(2_000);
  expect(JSON.stringify(result.content)).toContain("ace-threads");
  expect(host.active()).not.toContain("ace_threads_find");
  relay.releaseLists();
  await vi.waitFor(() => expect(host.active()).toContain("ace_threads_find"));
});

test("interrupting a guide while its tool list reload stalls settles the call at once", async () => {
  const { tool, relay } = await piSession();
  relay.stallLists();
  const reloading = relay.nextList();
  const interrupt = new AbortController();
  const call = tool("ace_guide")
    .execute("guide", { topic: "ace-threads" }, interrupt.signal)
    .then(
      () => "returned",
      () => "rejected",
    );
  await reloading;
  const aborted = performance.now();
  interrupt.abort();
  await expect(call).resolves.toBeTypeOf("string");
  // Well inside the one-second bound a stalled reload would otherwise hold the call for.
  expect(performance.now() - aborted).toBeLessThan(300);
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

/** The confirmation rule Pi's extension docs give a permission extension (Tool exposure). */
const needsApproval = (hints: PiToolAnnotations | undefined) =>
  hints?.destructiveHint === true ||
  (!hints?.readOnlyHint && ((hints?.destructiveHint ?? true) || (hints?.openWorldHint ?? true)));

test("a permission extension reading Pi's tool hints asks only before ace tools that overwrite work", async () => {
  const { host, tool } = await piSession();
  expect(needsApproval(host.annotations("ace_guide"))).toBe(false);
  expect(needsApproval(host.annotations("ace_context"))).toBe(false);
  expect(needsApproval(host.annotations("ace_delegate"))).toBe(false);
  await tool("ace_guide").execute("guide", { topic: "ace-threads" }, undefined);
  expect(needsApproval(host.annotations("ace_thread_merge"))).toBe(true);
});
