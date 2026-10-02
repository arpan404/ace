import { afterEach, test, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const controllers = new Set<AbortController>();
afterEach(() => {
  for (const controller of controllers) controller.abort();
  controllers.clear();
});

test("20 MiB has bounded peak live allocations at every output barrier with a stalled watcher", async () => {
  const controller = new AbortController();
  controllers.add(controller);
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--expose-gc", new URL("./memory-probe.ts", import.meta.url).pathname],
    { maxBuffer: 1024 * 1024, signal: controller.signal },
  );
  expect(stdout).toMatch(/^BOUNDED_20_MIB peakLiveDeltaBytes=\d+\n$/);
}, 120000);
