import { Item, ThreadId } from "@ace/protocol";
import { selectHandoff } from "../src/index.ts";
const source = {
  threadId: ThreadId.parse("bench"),
  throughSeq: 1000000,
  totalItems: 1000000,
  items: Array.from({ length: 200 }, (_, index) =>
    Item.parse({
      id: `item-${index}`,
      agentId: "root",
      createdAt: 1,
      type: "message",
      role: "assistant",
      complete: true,
      parts: [{ type: "text", text: "x".repeat(4096) }],
    }),
  ),
};
const iterations = 10000;
const start = performance.now();
for (let index = 0; index < iterations; index++) selectHandoff(source, 16384);
const elapsed = performance.now() - start;
process.stdout.write(
  JSON.stringify({
    iterations,
    opsPerSecond: (iterations / elapsed) * 1000,
    microsecondsPerOp: (elapsed * 1000) / iterations,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  }) + "\n",
);
