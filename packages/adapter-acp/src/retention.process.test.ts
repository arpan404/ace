import { expect, test } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { z } from "zod";

test("completed shell payloads have a fixed retained memory bound across hundreds of turns", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--expose-gc",
    fileURLToPath(new URL("./testing/retention.ts", import.meta.url)),
  ]);
  const result = z.object({ retainedBytes: z.number() }).parse(JSON.parse(stdout));
  expect(result.retainedBytes).toBeLessThan(8 * 1024 * 1024);
});
