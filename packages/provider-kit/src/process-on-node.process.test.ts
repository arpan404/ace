import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { win32 } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { runsOnBun } from "./bun-ffi.ts";
import { createKillOnCloseJob, createRetainedJob } from "./process-containment.ts";
import { windowsSystemExecutable } from "./process-owner.ts";
import { observeProcessGroups, probeOutput, spawnSupervised, stopOwnedGroups } from "./process.ts";

/*
 * The Electron main process bundles this code and runs it on Node, where it takes paths the
 * daemon (on Bun) never does: koffi instead of bun:ffi, the probe worker on Node's
 * worker_threads, and node:child_process as Node implements it. This file is in
 * `nodeOnlySuites` so those paths stay covered when the rest of the suite runs on Bun.
 */
if (runsOnBun()) throw new Error("This suite covers the Node paths; run it on Node");

const posix = process.platform !== "win32";

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    // Darwin can report EPERM for a group of zombies not yet reaped.
    return !(code === "ESRCH" || (process.platform === "darwin" && code === "EPERM"));
  }
}

/** Records the groups the kit owns while `run` runs. */
async function recordingGroups<T>(run: (recorded: Set<number>) => Promise<T>): Promise<T> {
  const recorded = new Set<number>();
  const stop = observeProcessGroups({
    add: (pid) => recorded.add(pid),
    remove: (pid) => recorded.delete(pid),
  });
  try {
    return await run(recorded);
  } finally {
    stop();
  }
}

test.runIf(posix)("on Node a probe returns its output and exit code", async () => {
  await expect(
    probeOutput("/bin/sh", ["-c", "printf ' out \\n'; printf err >&2; exit 3"]),
  ).resolves.toEqual({ stdout: "out", stderr: "err", code: 3 });
});

test("on Node a probe of a command that is not installed fails to start", async () => {
  await expect(
    probeOutput("ace-probe-missing-command", ["--version"], {
      env: { PATH: "/nonexistent-ace-probe-path" },
      timeoutMs: 10_000,
    }),
  ).rejects.toThrow("Probe failed to start");
});

test.runIf(posix)("on Node a probe past its timeout is stopped with its descendants", async () => {
  await recordingGroups(async (recorded) => {
    const running = probeOutput("/bin/sh", ["-c", "sleep 30 & sleep 30"], { timeoutMs: 300 });
    await expect.poll(() => recorded.size).toBe(1);
    const [pid] = recorded;
    if (pid === undefined) throw new Error("Probe was never recorded");
    await expect(running).rejects.toThrow("Probe timed out");
    expect(recorded.size).toBe(0);
    await expect.poll(() => groupAlive(pid), { timeout: 5000 }).toBe(false);
  });
});

test.runIf(posix)("on Node an aborted probe stops its descendants and rejects", async () => {
  await recordingGroups(async (recorded) => {
    const controller = new AbortController();
    const running = probeOutput("/bin/sh", ["-c", "sleep 30 & sleep 30"], {
      signal: controller.signal,
    });
    await expect.poll(() => recorded.size).toBe(1);
    const [pid] = recorded;
    if (pid === undefined) throw new Error("Probe was never recorded");
    controller.abort();
    await expect(running).rejects.toThrow("Probe aborted");
    await expect.poll(() => groupAlive(pid), { timeout: 5000 }).toBe(false);
  });
});

test.runIf(posix)(
  "on Node a global stop waits for a probe whose pid has not arrived yet and ends it",
  async () => {
    const seen: number[] = [];
    await recordingGroups(async (recorded) => {
      const stop = observeProcessGroups({ add: (pid) => seen.push(pid), remove: () => {} });
      try {
        const running = probeOutput("/bin/sh", ["-c", "sleep 30 & sleep 30"]);
        void running.catch(() => {});
        // Straight away: the worker has not reported the pid, so only the admission owns it.
        await stopOwnedGroups(0);
        expect(seen).toHaveLength(1);
        expect(recorded.size).toBe(0);
        expect(seen.map(groupAlive)).toEqual([false]);
        await running;
      } finally {
        stop();
      }
    });
  },
);

test.runIf(posix)(
  "on Node a stop of every owned group ends each group with its grandchildren",
  async () => {
    await recordingGroups(async (recorded) => {
      const proc = spawnSupervised({
        command: "/bin/sh",
        args: ["-c", "sleep 30 & echo ready; sleep 30"],
        env: {},
        name: "owned-tree",
      });
      await once(proc.stdout, "line");
      const pid = proc.pid;
      if (pid === undefined) throw new Error("Owned tree did not start");
      expect([...recorded]).toEqual([pid]);
      await stopOwnedGroups(100);
      expect(await proc.exited).toMatchObject({ reason: "stopped" });
      expect(recorded.size).toBe(0);
      await expect.poll(() => groupAlive(pid), { timeout: 5000 }).toBe(false);
    });
  },
);

test.runIf(posix)("on Node an owner that exits takes its owned group with it", async () => {
  const moduleUrl = new URL("./process.ts", import.meta.url).href;
  const script = `import { spawnSupervised } from ${JSON.stringify(moduleUrl)};
    const p = spawnSupervised({ command: "/bin/sh", args: ["-c", "sleep 30 & echo ready; sleep 30"], env: {}, name: "owned-tree" });
    p.stdout.once("line", () => { console.log(JSON.stringify({ pgid: p.pid })); process.exit(0); });`;
  // A plain Node parent outside the test runner, the way the Electron main process owns its
  // children: the kit's exit hook is all that stops the group.
  const owner = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(owner, "close");
  const stderr: Buffer[] = [];
  owner.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const lines = createInterface({ input: owner.stdout });
  const [line] = await Promise.race([
    once(lines, "line"),
    closed.then(() => {
      throw new Error(`Owner exited before starting its group: ${Buffer.concat(stderr)}`);
    }),
  ]);
  const { pgid } = z.object({ pgid: z.number().int().positive() }).parse(JSON.parse(String(line)));
  expect(await closed).toEqual([0, null]);
  await expect.poll(() => groupAlive(pgid), { timeout: 5000 }).toBe(false);
});

test.runIf(posix)(
  "on Node off Windows optional containment declines quietly and required containment fails",
  () => {
    // koffi cannot bind kernel32 here: the optional job leaves the tree stop in charge, and a
    // caller that needs a job hears that it has none instead of getting a job that holds nothing.
    expect(createKillOnCloseJob()).toBeUndefined();
    expect(() => createRetainedJob()).toThrow();
  },
);

test.runIf(process.platform === "win32")(
  "on Node a Windows job binds kernel32 through koffi and ends the tree it holds",
  async ({ onTestFinished }) => {
    expect(win32.basename(win32.dirname(windowsSystemExecutable("taskkill.exe")))).toMatch(
      /^system32$/i,
    );
    const job = createRetainedJob();
    onTestFinished(() => job.dispose());
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    onTestFinished(() => void child.kill());
    await once(child, "spawn");
    if (child.pid === undefined) throw new Error("Child did not start");
    job.assign(child.pid);
    expect(job.activeCount()).toBeGreaterThan(0);
    job.terminate();
    await expect.poll(() => job.activeCount()).toBe(0);
    // The taskkill tree stop resolves System32 through the same binding.
    const tree = spawnSupervised({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      env: {},
      name: "owned-tree",
    });
    expect(await tree.stop({ graceMs: 0 })).toMatchObject({ reason: "stopped" });
  },
);
