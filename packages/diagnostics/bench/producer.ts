import { performance } from "node:perf_hooks";
import { createLogger, logFields } from "../src/index.ts";
const wide: Record<string, unknown> = {};
for (let n = 0; n < 300000; n++) wide[`field${n}`] = n;
const fields = logFields([
  ["status", "working"],
  ["bytes", 128],
]);
const results: Record<string, number>[] = [];
for (const [name, data] of [
  ["prepared", fields],
  ["wideUnprepared", wide],
] as const) {
  const logger = createLogger({
    sink: { async write() {}, async close() {} },
    now: () => 0,
    redact: (line) => line,
    capacity: 1024,
  });
  let enqueueMs = 0;
  for (let batch = 0; batch < 400; batch++) {
    const began = performance.now();
    for (let n = 0; n < 256; n++) logger.log("info", "state", data);
    enqueueMs += performance.now() - began;
    await logger.flush();
  }
  results.push({
    [`${name}EnqueueMicrosecondsPerOp`]: (enqueueMs * 1000) / 102400,
    ...logger.stats(),
  });
  await logger.close();
}
console.log(
  JSON.stringify({ results, peakRssMiB: process.resourceUsage().maxRSS / 1024 }, null, 2),
);
