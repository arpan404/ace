import { test, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("20 MiB has bounded peak live allocations at every output barrier with a stalled watcher", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--expose-gc", new URL("./memory-probe.ts", import.meta.url).pathname],
    { maxBuffer: 1024 * 1024 },
  );
  expect(stdout).toMatch(/^BOUNDED_20_MIB peakLiveDeltaBytes=\d+\n$/);
}, 30000);
