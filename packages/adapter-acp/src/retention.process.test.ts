import { expect, test } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const Result = z.object({
  retainedBytes: z.number(),
  completedTools: z.number(),
  emittedChunks: z.number(),
  lastCommand: z.string(),
  lastOutputPrefix: z.string(),
  lastOutputTail: z.string(),
  failedTools: z.number(),
  completedTurns: z.number(),
  diagnosticPayloads: z.number(),
});
test("completed shell output and turn completion remain observable within a fixed memory bound", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--expose-gc",
    fileURLToPath(new URL("./testing/retention.ts", import.meta.url)),
  ]);
  const result = Result.parse(JSON.parse(stdout));
  expect(result).toMatchObject({
    completedTools: 900,
    emittedChunks: 900,
    lastCommand: "build-899",
    lastOutputPrefix: "899",
    lastOutputTail: "xxxxxxxx",
    failedTools: 0,
    completedTurns: 1,
  });
  expect(result.retainedBytes).toBeLessThan(8 * 1024 * 1024);
});

test("late failed-tool errors remain in diagnostics without accumulating retained payloads", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--expose-gc",
    fileURLToPath(new URL("./testing/retention.ts", import.meta.url)),
    "late-errors",
  ]);
  const result = Result.parse(JSON.parse(stdout));
  expect(result).toMatchObject({
    completedTools: 1000,
    failedTools: 1000,
    lastCommand: "build-999",
    diagnosticPayloads: 1000,
    completedTurns: 1,
  });
  expect(result.retainedBytes).toBeLessThan(8 * 1024 * 1024);
});

test.each(["late-title", "late-kind"])(
  "%s opaque payloads survive in diagnostics without accumulating retained tool data",
  async (mode) => {
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--expose-gc",
      fileURLToPath(new URL("./testing/retention.ts", import.meta.url)),
      mode,
    ]);
    const result = Result.parse(JSON.parse(stdout));
    expect(result).toMatchObject({
      completedTools: 1000,
      failedTools: 0,
      lastCommand: "build-999",
      emittedChunks: 1000,
      diagnosticPayloads: 1000,
      completedTurns: 1,
    });
    expect(result.retainedBytes).toBeLessThan(8 * 1024 * 1024);
  },
);
