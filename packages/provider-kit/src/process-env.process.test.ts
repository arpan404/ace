import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import { environmentLaunchError, launchLimits } from "./process-env.ts";
import { blockOfBytes, variableOfBytes } from "./testing/env-block.ts";

// The launch check's limits are the kernel's: what it accepts must really start a process.
const run = (env: Record<string, string>) =>
  spawnSync("/bin/sh", ["-c", "exit 0"], { env }).error?.message ?? "launched";

test.runIf(process.platform === "linux")(
  "an environment exactly at the launch limits starts a process, and one byte past a variable's limit can't",
  () => {
    const { string, block } = launchLimits("linux");
    const longest = variableOfBytes("AT_LIMIT", string);
    expect(environmentLaunchError(longest)).toBeUndefined();
    expect(run(longest)).toBe("launched");
    const over = variableOfBytes("AT_LIMIT", string + 1);
    expect(environmentLaunchError(over)).toBeDefined();
    expect(run(over)).toMatch(/E2BIG/);

    const full = blockOfBytes(block, 100_000);
    expect(environmentLaunchError(full)).toBeUndefined();
    expect(run(full)).toBe("launched");
  },
);
