import { describe, expect, it } from "vitest";
import { DeviceLogs } from "./index.ts";
function noop() {}
function deferred() {
  let resolve: () => void = noop;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe("bounded device logs", () => {
  it("streams fake logcat output while keeping only the last 256 lines", async () => {
    const logs = new DeviceLogs();
    const ended = deferred();
    const release = logs.subscribe(async (batch) => {
      if (batch.lines.some((line) => line.startsWith("[log stream ended:"))) ended.resolve();
    });
    try {
      await logs.start(
        {
          command: process.execPath,
          args: ["-e", "for(let i=0;i<1000;i++)process.stdout.write('log-'+i+'\\n')"],
        },
        {},
      );
      await ended.promise;
      const result = logs.tail(256);
      expect(result.lines).toHaveLength(256);
      expect(result.lines).toContain("log-999");
      expect(result.lines).not.toContain("log-0");
    } finally {
      release();
      await logs.close();
    }
  });
  it("a blocked client gets the latest bounded batch and a dropped-line count", async () => {
    const logs = new DeviceLogs();
    const gate = deferred();
    const entered = deferred();
    const delivered = deferred();
    const batches: { lines: string[]; dropped: number }[] = [];
    logs.subscribe(async (batch) => {
      batches.push(batch);
      if (batch.sequence === 1) {
        entered.resolve();
        await gate.promise;
      } else delivered.resolve();
    });
    logs.push("first");
    await entered.promise;
    for (let i = 0; i < 1000; i++) logs.push(`line-${i}`);
    gate.resolve();
    await delivered.promise;
    expect(batches[1]?.lines).toHaveLength(64);
    expect(batches[1]?.lines.at(-1)).toBe("line-999");
    expect(batches[1]?.dropped).toBe(936);
    await logs.close();
  });
  it("oversized fake simctl log lines terminate instead of growing memory", async () => {
    const logs = new DeviceLogs();
    const ended = deferred();
    logs.subscribe(async (batch) => {
      if (batch.lines.includes("[log stream ended: output-limit]")) ended.resolve();
    });
    try {
      await logs.start(
        {
          command: process.execPath,
          args: ["-e", "process.stdout.write('x'.repeat(100000)+'\\n')"],
        },
        {},
      );
      await ended.promise;
      expect(logs.tail(256).lines.every((line) => line.length <= 4096)).toBe(true);
      expect(logs.tail(256).lines).toContain("[log stream ended: output-limit]");
    } finally {
      await logs.close();
    }
  });
});
