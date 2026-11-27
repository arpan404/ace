/*
 * MCP requests through a real daemon on an empty temporary home: `tools/list` and a few
 * `tools/call`s, p50/p95 and response bytes. No provider starts. Run it with `HOME` set to an
 * empty temporary directory too, and with a phase's switch off and on (ADR 0225):
 *   HOME=$(mktemp -d) bun apps/daemon/bench/mcp-requests.ts [calls]
 * Add `--cpu-prof-md` to see where a call's time goes. Non-gating.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Agent, McpCapability, McpScope } from "@ace/protocol";
import { createDevThread, readConfig, startDaemon } from "../src/index.ts";

const calls = Number(process.argv[2] ?? 300);
const home = await mkdtemp(join(tmpdir(), "ace-mcp-requests-"));
const daemon = await startDaemon({
  config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
  modelInstances: [],
  history: { instances: [] },
});
const percentile = (values: number[], p: number) =>
  values.toSorted((a, b) => a - b)[Math.floor((values.length - 1) * p)] ?? 0;
try {
  const mcp = daemon.mcp;
  if (!mcp) throw new Error("The daemon started without its MCP endpoint");
  const thread = createDevThread(daemon.store, daemon.store.createWorkspace(home, "Measure"));
  const agent = Agent.parse({
    id: "measure",
    threadId: thread.id,
    parentId: null,
    origin: "root",
    cwd: home,
    fidelity: "full",
    status: { state: "working", activity: "thinking" },
    createdAt: 1,
    native: { provider: "codex", nativeId: "measure" },
  });
  daemon.store.appendEvents(thread.id, [{ type: "agent.created", agent }], 1);
  const scope = McpScope.parse({
    threadId: thread.id,
    agentId: agent.id,
    sessionId: "measure",
    capabilities: McpCapability.options,
  });
  const lease = mcp.openSession(scope, new AbortController().signal);
  const post = async (body: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(mcp.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lease.bearer}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
    });
    return response.text();
  };
  await post({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "measure", version: "1" },
    },
  });
  const cases: [string, unknown, Record<string, string>?][] = [
    ["tools/list", { jsonrpc: "2.0", id: 1, method: "tools/list" }],
    ["tools/list core", { jsonrpc: "2.0", id: 2, method: "tools/list" }, { "X-Ace-Tools": "core" }],
    [
      "tools/call context",
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "context", arguments: { topics: ["status"] } },
      },
    ],
    [
      "tools/call bad arguments",
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "thread_read", arguments: { nope: 1 } },
      },
    ],
  ];
  for (const [name, body, headers] of cases) {
    const times: number[] = [];
    let bytes = 0;
    const cpu = process.cpuUsage();
    for (let i = 0; i < calls; i++) {
      const start = performance.now();
      bytes = Buffer.byteLength(await post(body, headers));
      times.push(performance.now() - start);
    }
    const used = process.cpuUsage(cpu);
    process.stdout.write(
      `${JSON.stringify({
        name,
        calls,
        p50Ms: Number(percentile(times, 0.5).toFixed(3)),
        p95Ms: Number(percentile(times, 0.95).toFixed(3)),
        cpuUsPerCall: Math.round((used.user + used.system) / calls),
        responseBytes: bytes,
      })}\n`,
    );
  }
} finally {
  await daemon.close();
  await rm(home, { recursive: true, force: true });
}
