import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { z } from "zod";
import { createRetainedWindowsJob } from "./windows-job.ts";
import { processIdentity } from "./process-identity.ts";

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
          { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
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
    expect(job.activeCount()).toBeGreaterThan(0);
    child.stdin.end("launch");
    expect(await closed).toEqual([0, null]);
    expect(Buffer.concat(output).toString("utf8")).toBe("descendant-ready");
    expect(job.activeCount()).toBeGreaterThan(0);
    job.terminate();
    for (let attempt = 0; attempt < 200 && job.activeCount() > 0; attempt++) await delay(25);
    expect(job.activeCount()).toBe(0);
  },
);

test.runIf(process.platform === "win32")(
  "a hard-killed job owner cannot leave its detached child running",
  async ({ onTestFinished }) => {
    const moduleUrl = new URL("./windows-job.ts", import.meta.url).href;
    const owner = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { spawn } from 'node:child_process';
      const { createRetainedWindowsJob } = await import(${JSON.stringify(moduleUrl)});
      const job = createRetainedWindowsJob();
      const child = spawn(process.execPath, ['-e',
        'process.stdin.once("data", () => { console.log("ready"); setTimeout(() => process.exit(0), 15000); });'],
        { detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
      child.once('error', (error) => { console.error(error); process.exit(1); });
      child.once('spawn', () => { job.assign(child.pid); child.stdin.end('run'); });
      child.stdout.once('data', () => console.log(JSON.stringify({ pid: child.pid })));
      setInterval(() => {}, 1000);
    `,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    const exited = once(owner, "exit");
    const output = createInterface({ input: owner.stdout });
    const stderr: Buffer[] = [];
    owner.stderr.on("data", (bytes: Buffer) => stderr.push(bytes));
    onTestFinished(async () => {
      owner.kill("SIGKILL");
      await exited.catch(() => {});
      output.close();
    });
    const ready = await Promise.race([
      once(output, "line"),
      exited.then(() => {
        throw new Error(`Owner exited before admission: ${Buffer.concat(stderr)}`);
      }),
    ]);
    const [line] = z.tuple([z.string()]).parse(ready);
    const child = z.object({ pid: z.number().int().positive() }).parse(JSON.parse(line));
    const before = processIdentity(child.pid);
    expect(before).toBeDefined();
    owner.kill("SIGKILL");
    await exited;
    const deadline = performance.now() + 5000;
    for (;;) {
      const current = processIdentity(child.pid);
      if (!current || current.start !== before?.start) break;
      if (performance.now() >= deadline) throw new Error("Detached child survived owner death");
      await delay(25);
    }
  },
);
