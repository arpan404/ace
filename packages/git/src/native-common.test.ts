import { describe, expect, test } from "vitest";
import { gitFallbackCounts, runNativeOp, runNativeOpSync } from "./native-common.ts";

describe("native selection for parts with no addon export", () => {
  // The addon exports no reads or writes probe (the reads and writes are Rust-only), so a native
  // selection for them runs the ordinary Git implementation and records the fallback, instead of
  // calling an addon method that isn't there.
  test("reads and writes complete through TypeScript and count the fallback", async () => {
    const before = gitFallbackCounts().unimplemented ?? 0;
    expect(await runNativeOp("reads", "status", async () => "read")).toBe("read");
    expect(runNativeOpSync("writes", "commit", () => "write")).toBe("write");
    expect(gitFallbackCounts().unimplemented).toBe(before + 2);
  });
});
