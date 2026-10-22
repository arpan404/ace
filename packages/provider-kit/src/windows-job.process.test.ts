import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { createRetainedWindowsJob } from "./windows-job.ts";

test.runIf(process.platform === "win32")(
  "a Windows job retains and terminates a descendant after its original process exits",
  async ({ onTestFinished }) => {
    const job = createRetainedWindowsJob();
    onTestFinished(() => {
      try {
        job.terminate();
      } finally {
        job.dispose();
      }
    });
    // This trusted launcher waits until the parent has assigned its job before spawning.
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
      const { spawn } = require('node:child_process');
      process.stdin.once('data', () => {
        const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' });
        descendant.once('spawn', () => { descendant.unref(); process.exit(0); });
      });
    `,
      ],
      { stdio: ["pipe", "ignore", "ignore"], windowsHide: true },
    );
    onTestFinished(() => {
      child.kill();
    });
    const closed = once(child, "close");
    await once(child, "spawn");
    if (child.pid === undefined) throw new Error("Launcher did not start");
    job.assign(child.pid);
    child.stdin.end("launch");
    await closed;
    expect(job.activeCount()).toBeGreaterThan(0);
    job.terminate();
    for (let attempt = 0; attempt < 200 && job.activeCount() > 0; attempt++) await delay(25);
    expect(job.activeCount()).toBe(0);
  },
);
