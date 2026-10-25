import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { probeOutput } from "@ace/provider-kit/process";

test(
  "a thread snapshot the repository drops is freed instead of staying in the record cache",
  { timeout: 60_000 },
  async ({ signal, onTestFinished }) => {
    const operation = probeOutput(
      process.execPath,
      [
        "--no-warnings",
        fileURLToPath(new URL("../testing/snapshot-retention-worker.ts", import.meta.url)),
        "1500",
      ],
      { maxBytes: 4096, timeoutMs: 60_000, signal },
    );
    onTestFinished(async () => {
      await operation.catch(() => {});
    });
    const result = await operation;
    expect(result.code, result.stderr).toBe(0);
    const usage = z
      .object({ reloads: z.number(), retainedIncrease: z.number() })
      .parse(JSON.parse(result.stdout));
    expect(usage.reloads).toBe(1500);
    // Each pinned snapshot held about 38 KB, so 1500 reloads used to keep about 57 MB.
    expect(usage.retainedIncrease).toBeLessThan(4 * 1024 * 1024);
  },
);
