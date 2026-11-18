import { describe, expect, it } from "vitest";
import { runProcess } from "./run-process.ts";

/*
 * A real child process: the deploy's smoke runs as one, and a smoke that hangs must end as a
 * failed smoke (so the release rolls back) instead of holding the deploy forever.
 */
describe("running a release step's process", () => {
  it("ends a process that outlives its deadline and reports it failed", async () => {
    const started = performance.now();
    const ran = await runProcess("node", ["-e", "setInterval(() => {}, 1000)"], {
      cwd: process.cwd(),
      capture: true,
      timeoutMs: 300,
    });
    expect(ran.code).not.toBe(0);
    expect(ran.output).toContain("timed out after 300ms");
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("returns a quick process's own exit code and output", async () => {
    const ran = await runProcess("node", ["-e", "console.log('hi'); process.exit(3)"], {
      cwd: process.cwd(),
      capture: true,
      timeoutMs: 10_000,
    });
    expect(ran).toEqual({ code: 3, output: "hi\n" });
  });
});
