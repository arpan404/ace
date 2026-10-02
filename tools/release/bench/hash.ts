import { mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { hashFile } from "@ace/service";
const root = await mkdtemp(join(tmpdir(), "ace-hash-bench-"));
try {
  const file = join(root, "data");
  const fd = await open(file, "w");
  const block = Buffer.alloc(64 * 1024, 42);
  try {
    for (let i = 0; i < 1024; i++) await fd.write(block);
  } finally {
    await fd.close();
  }
  const start = performance.now();
  for (let i = 0; i < 4; i++) await hashFile(file);
  process.stdout.write(
    JSON.stringify({
      mibPerSecond: 256 / ((performance.now() - start) / 1000),
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
    }) + "\n",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
const { Readable } = await import("node:stream");
const { pipeline } = await import("node:stream/promises");
const { BoundedLog } = await import("@ace/service");
const logRoot = await mkdtemp(join(tmpdir(), "ace-log-bench-"));
try {
  const block = Buffer.alloc(64 * 1024, 42);
  const source = async function* () {
    for (let i = 0; i < 1024; i++) yield block;
  };
  const start = performance.now();
  await pipeline(Readable.from(source()), new BoundedLog(join(logRoot, "log")));
  process.stdout.write(
    JSON.stringify({
      logMiBPerSecond: 64 / ((performance.now() - start) / 1000),
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
    }) + "\n",
  );
} finally {
  await rm(logRoot, { recursive: true, force: true });
}
const { MaintenanceGate } = await import("@ace/service");
const { Command } = await import("@ace/protocol");
const gate = new MaintenanceGate(() => 0);
const command = Command.parse({
  id: "bench",
  deviceId: "bench",
  payload: {
    type: "thread.send",
    threadId: "bench",
    delivery: "queue",
    input: [{ type: "text", text: "benchmark" }],
  },
});
gate.enter();
let allowed = 0;
const start = performance.now();
for (let i = 0; i < 1_000_000; i++) if (gate.admitCommand(command)) allowed++;
if (allowed) throw new Error("Drain admitted new work");
process.stdout.write(
  JSON.stringify({
    admissionsPerSecond: 1_000_000 / ((performance.now() - start) / 1000),
    peakRssMiB: process.resourceUsage().maxRSS / 1024,
  }) + "\n",
);
