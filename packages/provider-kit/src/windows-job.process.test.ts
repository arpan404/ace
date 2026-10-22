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
        const descendant = spawn(process.execPath,
          ['-e', 'console.log("descendant-ready"); setInterval(() => {}, 60000)'],
          { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
        descendant.once('error', (error) => { console.error(error); process.exit(1); });
        descendant.stdout.once('data', () => {
          descendant.stdout.destroy();
          descendant.unref();
          process.stdout.write('descendant-ready', () => process.exit(0));
        });
      });
    `,
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    onTestFinished(() => {
      child.kill();
    });
    const closed = once(child, "close");
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    await once(child, "spawn");
    if (child.pid === undefined) throw new Error("Launcher did not start");
    job.assign(child.pid);
    expect(job.activeCount()).toBe(1);
    child.stdin.end("launch");
    expect(await closed).toEqual([0, null]);
    expect(Buffer.concat(output).toString("utf8")).toBe("descendant-ready");
    expect(job.activeCount()).toBeGreaterThan(0);
    job.terminate();
    for (let attempt = 0; attempt < 200 && job.activeCount() > 0; attempt++) await delay(25);
    expect(job.activeCount()).toBe(0);
  },
);
