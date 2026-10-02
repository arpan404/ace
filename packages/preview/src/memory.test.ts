import { expect, test } from "vitest";
import { z } from "zod";
import { probeOutput } from "@ace/provider-kit/process";
import { fileURLToPath } from "node:url";

test("a 50 MiB download retains less than 8 MiB of byte buffers in an isolated process", async () => {
  const result = await probeOutput(
    process.execPath,
    ["--expose-gc", fileURLToPath(new URL("./testing/memory-worker.ts", import.meta.url))],
    { maxBytes: 4096 },
  );
  expect(result.code).toBe(0);
  const usage = z
    .object({ received: z.number(), retainedBufferIncrease: z.number() })
    .parse(JSON.parse(result.stdout));
  expect(usage.received).toBe(50 * 1024 * 1024);
  expect(usage.retainedBufferIncrease).toBeLessThan(8 * 1024 * 1024);
});
