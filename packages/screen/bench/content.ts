import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { z } from "zod";
import { CredentialRegistry, ToolRegistry, nodeScheduler } from "@ace/mcp-server";
import { McpScope } from "@ace/protocol";
import { lineReader } from "@ace/provider-kit/process";
const registry = new ToolRegistry({ scheduler: nodeScheduler });
const data = Buffer.alloc(1024 * 1024).toString("base64");
registry.registerContent({
  name: "screen_screenshot",
  description: "Benchmark image validation",
  input: z.object({}),
  capability: "screen",
  timeoutMs: 1000,
  async run() {
    return { content: [{ type: "image", mimeType: "image/jpeg", data }] };
  },
});
const credentials = new CredentialRegistry(() => "a".repeat(64));
const lease = credentials.issue(
  McpScope.parse({
    sessionId: "bench",
    threadId: "thread",
    agentId: "agent",
    capabilities: ["screen"],
  }),
  new AbortController().signal,
);
const signal = new AbortController().signal;
const started = performance.now();
for (let i = 0; i < 100; i++) {
  const result = await registry.call("screen_screenshot", {}, lease.principal, signal);
  if (result.isError) throw new Error("Image benchmark failed validation");
}
console.log(`MCP 1 MiB image: ${((performance.now() - started) * 10).toFixed(2)} us/op`);
const chunk = Buffer.from("x".repeat(1023) + "\n");
const start = performance.now();
const input = Readable.from(
  (function* () {
    for (let i = 0; i < 10000; i++) yield chunk;
  })(),
);
const lines = lineReader(input, 1024, () => {
  throw new Error("Unexpected line limit");
});
let count = 0;
lines.on("line", () => count++);
await new Promise<void>((resolve) => lines.once("close", resolve));
console.log(
  `bounded 1 KiB line: ${(((performance.now() - start) * 1000) / count).toFixed(2)} us/op`,
);
console.log(
  JSON.stringify({
    rssBytes: process.memoryUsage().rss,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  }),
);
lease.end();
