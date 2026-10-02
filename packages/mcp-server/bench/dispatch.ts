import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { McpScope } from "@ace/protocol";
import { CredentialRegistry, ToolRegistry, nodeScheduler, startMcpServer } from "../src/index.ts";

const credentials = new CredentialRegistry(() => randomBytes(32).toString("hex"));
const lease = credentials.issue(
  McpScope.parse({ sessionId: "bench", threadId: "thread", agentId: "root", capabilities: [] }),
  new AbortController().signal,
);
const registry = new ToolRegistry({ scheduler: nodeScheduler });
registry.register({
  name: "ace_echo",
  description: "Benchmark",
  input: z.strictObject({ n: z.number() }),
  output: z.strictObject({ n: z.number() }),
  capability: null,
  timeoutMs: 1000,
  async run(input) {
    return input;
  },
});
function report(name: string, count: number, start: number) {
  const ms = performance.now() - start;
  process.stdout.write(
    `${name}: ${Math.round((count * 1000) / ms)} ops/s, ${((ms * 1000) / count).toFixed(2)} us/op, peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MiB\n`,
  );
}
let start = performance.now();
for (let i = 0; i < 200_000; i++) credentials.authenticate(lease.bearer);
report("credential lookup", 200_000, start);
const signal = new AbortController().signal;
for (let i = 0; i < 1000; i++) await registry.call("ace_echo", { n: i }, lease.principal, signal);
start = performance.now();
for (let i = 0; i < 20_000; i++) await registry.call("ace_echo", { n: i }, lease.principal, signal);
report("validated dispatch", 20_000, start);
const server = await startMcpServer({ registry, credentials });
const client = new Client(
  { name: "bench", version: "1" },
  { versionNegotiation: { mode: { pin: "2026-07-28" } } },
);
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${lease.bearer}` } },
    }),
  );
  await client.listTools();
  start = performance.now();
  for (let i = 0; i < 1000; i++) await client.callTool({ name: "ace_echo", arguments: { n: i } });
  report("current HTTP round trip", 1000, start);
} finally {
  await client.close();
  await server.close();
}
