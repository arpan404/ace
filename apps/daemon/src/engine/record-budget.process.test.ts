import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { probeOutput } from "@ace/provider-kit/process";

test(
  "a long-lived section keeps no bookkeeping for keys the shared budget has evicted",
  { timeout: 60_000 },
  async ({ signal, onTestFinished }) => {
    const operation = probeOutput(
      process.execPath,
      [
        "--no-warnings",
        fileURLToPath(new URL("../testing/record-budget-churn-worker.ts", import.meta.url)),
        "200000",
      ],
      { maxBytes: 4096, timeoutMs: 60_000, signal },
    );
    onTestFinished(async () => {
      await operation.catch(() => {});
    });
    const result = await operation;
    expect(result.code, result.stderr).toBe(0);
    const usage = z
      .object({ keys: z.number(), resident: z.number(), retainedIncrease: z.number() })
      .parse(JSON.parse(result.stdout));
    expect(usage.keys).toBe(200_000);
    // The other section's 64 entries filled the budget, so none of this section's stayed cached.
    expect(usage.resident).toBe(0);
    // Remembering every key ever cached kept about 18 MB for 200,000 keys.
    expect(usage.retainedIncrease).toBeLessThan(2 * 1024 * 1024);
  },
);
