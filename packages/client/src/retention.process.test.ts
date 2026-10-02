import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

test("a paused output consumer does not retain chunks it already consumed", async () => {
  const run = promisify(execFile);
  const result = await run(process.execPath, [
    "--expose-gc",
    fileURLToPath(new URL("./retention.fixture.ts", import.meta.url)),
  ]);
  expect(result.stdout).toBe("");
});
