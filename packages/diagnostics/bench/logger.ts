import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createRedactor } from "@ace/redaction";
import { createLogger, createFileSink } from "../src/index.ts";
const directory = await mkdtemp(join(tmpdir(), "ace-log-bench-"));
const context = { home: homedir(), env: process.env };
const logger = createLogger({
  sink: await createFileSink({
    directory,
    fileBytes: 1024 * 1024,
    totalBytes: 8 * 1024 * 1024,
    context,
  }),
  now: Date.now,
  redact: createRedactor(context),
  capacity: 4096,
  recentCapacity: 256,
});
const entries = 100000;
let enqueueMs = 0;
const began = performance.now();
try {
  for (let offset = 0; offset < entries; offset += 256) {
    const enqueueBegan = performance.now();
    for (let i = 0; i < 256 && offset + i < entries; i++) {
      logger.log("info", "Provider process changed state", {
        session: "synthetic-session",
        bytes: 128,
        status: "working",
      });
    }
    enqueueMs += performance.now() - enqueueBegan;
    await logger.flush();
  }
  const elapsedMs = performance.now() - began;
  console.log(
    JSON.stringify(
      {
        entries,
        enqueueOpsPerSecond: Math.round((entries / enqueueMs) * 1000),
        persistedOpsPerSecond: Math.round((entries / elapsedMs) * 1000),
        enqueueMicrosecondsPerOp: (enqueueMs * 1000) / entries,
        peakRssMiB: process.resourceUsage().maxRSS / 1024,
        ...logger.stats(),
      },
      null,
      2,
    ),
  );
} finally {
  await logger.close();
  await rm(directory, { recursive: true, force: true });
}
