import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { KILL_GRACE_MS, TERMINATE_GRACE_MS } from "../liveness/stop.ts";
import { runCommand } from "./command-process.ts";

/*
 * Stop is final for a background shell (ADR 0052): one that ignores SIGTERM is sent SIGKILL
 * after the grace, so its job ends stopped within the bound. A real process: the signals are
 * the edge under test.
 */

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

it.skipIf(process.platform === "win32")(
  "a background shell that ignores SIGTERM is killed after the grace and its job ends stopped",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ace-command-stop-"));
    homes.push(cwd);
    const job = runCommand(
      (spec) => spawnRawSupervised({ ...spec, name: "command-stop", killGroupOnExit: true }),
      {
        now: () => performance.now(),
        schedule: (ms, run) => {
          const timer = setTimeout(run, ms);
          return () => clearTimeout(timer);
        },
      },
      {
        command: "/bin/sh",
        args: ["-c", "trap '' TERM; echo ready; while :; do sleep 1; done"],
        cwd,
        env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
      },
      { timeoutMs: 60_000, tailBytes: 4096 },
    );
    // It is running and has set its trap.
    for (let tries = 0; tries < 100 && !job.stdout.text().includes("ready"); tries++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(job.stdout.text()).toContain("ready");

    const stoppedAt = performance.now();
    job.stop();
    const outcome = await job.done;
    const took = performance.now() - stoppedAt;
    expect(outcome.stopped).toBe(true);
    // It outlived SIGTERM, and SIGKILL ended it inside the bound.
    expect(took).toBeGreaterThanOrEqual(TERMINATE_GRACE_MS - 100);
    expect(took).toBeLessThan(TERMINATE_GRACE_MS + KILL_GRACE_MS + 1_000);
  },
  15_000,
);
