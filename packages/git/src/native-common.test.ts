import { describe, expect, test } from "vitest";
import { gitFallbackCounts, runNativeOp, runNativeOpSync } from "./native-common.ts";

describe("native selection without napi probes", () => {
  test("reads and writes complete through the TypeScript path when native is selected", async () => {
    expect(await runNativeOp("reads", "status", async () => "read")).toBe("read");
    expect(runNativeOpSync("writes", "commit", () => "write")).toBe("write");
    expect(gitFallbackCounts().unimplemented).toBeGreaterThanOrEqual(2);
  });
});