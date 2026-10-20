import { expect, onTestFinished, test } from "vitest";
import { z } from "zod";
import { AgentId, ThreadId } from "@ace/protocol";
import { spawnSupervised } from "@ace/provider-kit/process";
import { JsonRpcPeer } from "@ace/provider-kit/jsonrpc";
import {
  CredentialRegistry,
  ToolRegistry,
  acpInjection,
  acpStdioInjection,
  acpToolListing,
  nodeScheduler,
  startMcpServer,
} from "./index.ts";

/**
 * Each ACP agent lists what its own tool refresh supports, through ace's stdio bridge as a real
 * child process: Gemini CLI reloads (core), claude-agent-acp and Antigravity defer like Claude
 * Code (every tool), and any other agent keeps a fixed list.
 */
async function bridged(cli: string | undefined) {
  const tools = new ToolRegistry({ scheduler: nodeScheduler });
  for (const [name, toolset, description] of [
    ["thread_read", "ace-threads", "Read another thread's transcript."],
    ["notify", undefined, "Notify the person."],
  ] as const)
    tools.register({
      name,
      description,
      capability: null,
      timeoutMs: 1000,
      ...(toolset ? { toolset } : {}),
      input: z.object({}),
      output: z.object({}),
      async run() {
        return {};
      },
    });
  const credentials = new CredentialRegistry(() => "e".repeat(64));
  const lifetime = new AbortController();
  onTestFinished(() => lifetime.abort());
  const lease = credentials.issue(
    {
      sessionId: "acp",
      threadId: ThreadId.parse("t"),
      agentId: AgentId.parse("a"),
      capabilities: [],
    },
    lifetime.signal,
  );
  const server = await startMcpServer({ registry: tools, credentials });
  onTestFinished(() => server.close());
  const listing = acpToolListing(cli);
  const definition = acpStdioInjection({ url: server.url, bearer: lease.bearer, listing })
    .mcpServers[0];
  if (!definition) throw new Error("No bridge definition");
  const proc = spawnSupervised({
    command: definition.command,
    args: definition.args,
    env: Object.fromEntries(definition.env.map((value) => [value.name, value.value])),
    name: "acp-listing-bridge",
  });
  const rpc = new JsonRpcPeer(proc);
  onTestFinished(async () => {
    await proc.stop();
  });
  await rpc.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: cli ?? "unknown", version: "1" },
  });
  await rpc.notify("notifications/initialized");
  const listed = async () =>
    z
      .object({ tools: z.array(z.object({ name: z.string() })) })
      .parse(await rpc.request("tools/list", {}))
      .tools.map((tool) => tool.name)
      .toSorted();
  const find = () =>
    rpc.request("tools/call", { name: "tools_find", arguments: { query: "read a thread" } });
  return { listing, listed, find, http: acpInjection({ ...lease, url: server.url, listing }) };
}

test("Gemini CLI starts with the core list and grows it as the agent finds tools", async () => {
  const gemini = await bridged("gemini");
  expect(await gemini.listed()).toEqual(["context", "notify", "tools_call", "tools_find"]);
  await gemini.find();
  expect(await gemini.listed()).toContain("thread_read");
  expect(gemini.http.mcpServers[0]?.headers).toContainEqual({ name: "X-Ace-Tools", value: "core" });
});

test("claude-agent-acp and Antigravity list every tool, as Claude Code does", async () => {
  // Both load only always-load tools upfront and reach the rest on demand.
  for (const cli of ["claude-acp", "antigravity"]) {
    const agent = await bridged(cli);
    expect(await agent.listed(), cli).toEqual(["context", "notify", "thread_read", "tools_find"]);
    expect(
      agent.http.mcpServers[0]?.headers.map((header) => header.name),
      cli,
    ).not.toContain("X-Ace-Tools");
  }
});

test("any other ACP agent keeps a fixed list and reaches the rest through tools_call", async () => {
  for (const cli of ["goose", undefined]) {
    const agent = await bridged(cli);
    // A fixed list keeps only the core tools: even a tool without a family waits for tools_call.
    expect(await agent.listed(), cli).toEqual(["context", "tools_call", "tools_find"]);
    await agent.find();
    expect(await agent.listed(), cli).not.toContain("thread_read");
    expect(agent.http.mcpServers[0]?.headers, cli).toContainEqual({
      name: "X-Ace-Tools",
      value: "static",
    });
  }
});
