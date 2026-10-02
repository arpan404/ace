import { performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserService, detectChromium } from "../src/index.ts";
import { decodeEvaluationValue } from "../src/evaluation-value.ts";

// Includes the new host boundary. Run separately from the Chromium round trip.
const text = JSON.stringify("😀".repeat(16_384));
const iterations = 10_000;
let start = performance.now();
for (let i = 0; i < iterations; i++) decodeEvaluationValue(text);
report("trusted 64 KiB UTF-8 decode", iterations, start);

const executablePath = await detectChromium();
if (!executablePath) {
  console.log("Chromium unavailable: renderer/transport measurements skipped");
} else {
  const dataDir = await mkdtemp(join(tmpdir(), "ace-browser-eval-bench-"));
  const service = new BrowserService({ dataDir, executablePath, evaluatePolicy: () => true });
  try {
    await service.open({ threadId: "bench", workspaceId: "bench" });
    for (const [name, expression] of [
      ["1 KiB ASCII", "'x'.repeat(1024)"],
      ["64 KiB emoji", "'😀'.repeat(16384)"],
      ["200 KiB ASCII", "'x'.repeat(204800)"],
    ]) {
      if (!expression) throw new Error("Missing benchmark expression");
      start = performance.now();
      for (let i = 0; i < 200; i++)
        await service.execute("bench", { action: "evaluate", expression });
      report(`${name} renderer guard/CDP/host decode`, 200, start);
    }
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

function report(path: string, count: number, started: number): void {
  const elapsed = performance.now() - started;
  console.log(
    JSON.stringify({
      path,
      iterations: count,
      opsPerSecond: Math.round((count * 1000) / elapsed),
      microseconds: (elapsed * 1000) / count,
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
    }),
  );
}
