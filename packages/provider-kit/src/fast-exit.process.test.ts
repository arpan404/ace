import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ProcessInventory, inventoryRuntime } from "./process-inventory.ts";
import { processIdentity } from "./process-identity.ts";
import { observeProcessGroups, spawnRawSupervised, spawnSupervised } from "./process.ts";

/** Hold Node's reaper back until the kernel reports that this real child has exited. */
function waitForZombie(pid: number): void {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const status = execFileSync("ps", ["-p", String(pid), "-o", "stat="], {
      encoding: "utf8",
    });
    if (status.trim().startsWith("Z")) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  throw new Error("Child did not exit before identity inspection");
}

for (const mode of ["bytes", "lines"] as const)
  test.runIf(process.platform === "darwin")(
    `a child exiting before identity inspection keeps its status and ${mode} output`,
    async () => {
      const home = mkdtempSync(join(tmpdir(), "ace-fast-exit-"));
      const inventory = new ProcessInventory(join(home, "processes.sqlite"), {
        ...inventoryRuntime,
        identity(pid) {
          if (pid !== process.pid) waitForZombie(pid);
          return processIdentity(pid);
        },
      });
      const unobserve = observeProcessGroups(inventory);
      try {
        const options = {
          command: process.execPath,
          args: [
            "-e",
            "process.stdout.write('final out\\n'); process.stderr.write('final err\\n'); process.exitCode = 23",
          ],
          env: {},
          name: "fast-exit",
        };
        const stdout: string[] = [];
        const stderr: string[] = [];
        const proc = mode === "bytes" ? spawnRawSupervised(options) : spawnSupervised(options);
        const event = mode === "bytes" ? "data" : "line";
        proc.stdout.on(event, (chunk: Buffer | string) => stdout.push(String(chunk)));
        proc.stderr.on(event, (chunk: Buffer | string) => stderr.push(String(chunk)));
        expect(await proc.exited).toEqual({ code: 23, signal: null, reason: "exit" });
        expect(stdout.join("")).toBe(mode === "bytes" ? "final out\n" : "final out");
        expect(stderr.join("")).toBe(mode === "bytes" ? "final err\n" : "final err");
        expect(await proc.stop({ graceMs: 0 })).toEqual({ code: 23, signal: null, reason: "exit" });
        expect(inventory.list()).toEqual([]);
      } finally {
        unobserve();
        inventory.close();
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

for (const retained of [false, true])
  test.runIf(process.platform === "darwin")(
    `an unidentified exited leader's descendants still stop${retained ? " when retained" : " on exit"}`,
    async () => {
      const home = mkdtempSync(join(tmpdir(), "ace-fast-tree-"));
      const inventory = new ProcessInventory(join(home, "processes.sqlite"), {
        ...inventoryRuntime,
        identity(pid) {
          if (pid !== process.pid) waitForZombie(pid);
          return processIdentity(pid);
        },
      });
      const unobserve = observeProcessGroups(inventory);
      try {
        const proc = spawnRawSupervised({
          command: process.execPath,
          args: [
            "-e",
            "const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: ['ignore', 1, 2]}); child.unref(); console.log('final'); process.exitCode = 7",
          ],
          env: {},
          name: "fast-tree",
          killGroupOnExit: !retained,
        });
        const output: string[] = [];
        proc.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString()));
        if (retained) {
          await new Promise<void>((resolve) => {
            if (proc.signal.aborted) resolve();
            else proc.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          await proc.stop({ graceMs: 0 });
        }
        expect(await proc.exited).toEqual({
          code: 7,
          signal: null,
          reason: retained ? "stopped" : "exit",
        });
        expect(output.join("")).toBe("final\n");
        expect(inventory.list()).toEqual([]);
      } finally {
        unobserve();
        inventory.close();
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
