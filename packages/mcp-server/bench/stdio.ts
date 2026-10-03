// Synthetic stdio/fetch boundary. No provider and no external network. Do not run during development.
import { PassThrough, Writable } from "node:stream";
import { z } from "zod";
import { runStdioBridge } from "../src/index.ts";
const input = new PassThrough();
let count = 0;
const output = new Writable({
  write(_chunk, _encoding, done) {
    count++;
    if (count < 10000)
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: count, method: "tools/list" })}\n`);
    else input.end();
    done();
  },
});
const start = performance.now();
const running = runStdioBridge({
  input,
  output,
  signal: new AbortController().signal,
  connection: { url: "http://127.0.0.1:1/mcp", bearer: "a".repeat(64) },
  fetch: async (_url, options) => {
    const message = z.object({ id: z.number() }).parse(JSON.parse(String(options?.body)));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }));
  },
});
input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list" })}\n`);
await running;
const ms = performance.now() - start;
process.stdout.write(
  `${JSON.stringify({ requests: count, opsPerSecond: (count * 1000) / ms, microsecondsPerOp: (ms * 1000) / count, peakRssKiB: process.resourceUsage().maxRSS, runtime: process.version })}\n`,
);
