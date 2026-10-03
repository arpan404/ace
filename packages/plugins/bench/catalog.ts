import { performance } from "node:perf_hooks";
import { fixture } from "../src/test-support.ts";
const commands = Object.fromEntries(
  Array.from({ length: 256 }, (_, index) => [
    `command-${index}`,
    { content: "x".repeat(512), description: `Command ${index}` },
  ]),
);
const f = await fixture({
  ".claude-plugin/plugin.json": JSON.stringify({ name: "sample", commands }),
});
try {
  await f.manager.accept(await f.prepare());
  const coldStart = performance.now();
  await f.manager.catalog(0, 50);
  const coldMs = performance.now() - coldStart;
  const count = 10_000,
    started = performance.now();
  for (let index = 0; index < count; index++) await f.manager.catalog((index % 6) * 50, 50);
  const elapsed = performance.now() - started;
  console.log(
    JSON.stringify({
      operation: "plugin-catalog-256-inline-commands",
      coldMs,
      opsPerSecond: (count * 1000) / elapsed,
      microsecondsPerOp: (elapsed * 1000) / count,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    }),
  );
} finally {
  await f.close();
}
