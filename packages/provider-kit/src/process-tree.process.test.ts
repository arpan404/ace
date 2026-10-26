import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { observeProcessGroups, spawnRawSupervised, spawnSupervised } from "./process.ts";
import { spawnBytes } from "./process-bytes.ts";
import { stopOwnedGroups } from "./process-owner.ts";
import type { TreePorts } from "./process-tree.ts";

const windowsHost = process.platform === "win32";
const stubborn = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";

/** Off Windows, taskkill is stood in for by signalling the leader, so the branch runs anywhere. */
function signalLeader(pid: number, force: boolean): void {
  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** A Job Object stand-in whose release is observable. */
function fakeJob() {
  const job = { joined: 0, released: false };
  const factory = () => ({
    assign: () => void job.joined++,
    dispose: () => void (job.released = true),
  });
  return { job, factory };
}

type Mode = {
  name: string;
  ports: TreePorts;
  /** How a forced stop shows in the exit: a signal on POSIX, taskkill /F's exit code on Windows. */
  forced: { signal: NodeJS.Signals | null };
  /** Windows console children cannot be asked to close; only a forced stop ends them. */
  polite: boolean;
};
const modes: Mode[] = windowsHost
  ? [{ name: "Windows tree", ports: {}, forced: { signal: null }, polite: false }]
  : [
      { name: "process group", ports: {}, forced: { signal: "SIGKILL" }, polite: true },
      {
        name: "Windows tree stop",
        ports: { platform: "win32", killTree: signalLeader, jobFactory: () => undefined },
        forced: { signal: "SIGKILL" },
        polite: true,
      },
    ];

async function waitForFile(path: string): Promise<void> {
  await expect
    .poll(() =>
      readFile(path, "utf8").then(
        () => true,
        () => false,
      ),
    )
    .toBe(true);
}

/** A child that ignores the polite stop, started once it is ready to ignore it. */
async function stubbornChild(ports: TreePorts, retained = false) {
  const root = await mkdtemp(join(tmpdir(), "ace-tree-"));
  const ready = join(root, "ready");
  const proc = spawnRawSupervised({
    ...ports,
    command: process.execPath,
    args: ["-e", `require('node:fs').writeFileSync(process.env.READY, ''); ${stubborn}`],
    env: { READY: ready },
    name: "stubborn",
    ...(retained ? { killGroupOnExit: false } : {}),
  });
  await waitForFile(ready);
  await rm(root, { recursive: true, force: true });
  return proc;
}

describe.each(modes)("an owned $name", (mode) => {
  test("a clean exit keeps its final output and status", async () => {
    const proc = spawnSupervised({
      ...mode.ports,
      command: process.execPath,
      args: ["-e", "console.log('final'); process.exitCode = 23"],
      env: {},
      name: "exit",
    });
    const lines: string[] = [];
    proc.stdout.on("line", (line) => lines.push(line));
    expect(await proc.exited).toEqual({ code: 23, signal: null, reason: "exit" });
    expect(lines).toEqual(["final"]);
  });

  for (const retained of [false, true])
    test(`a child ignoring the polite stop is forced after the grace${retained ? " when retained" : ""}`, async () => {
      const proc = await stubbornChild(mode.ports, retained);
      const exit = await proc.stop({ graceMs: 50 });
      expect(exit).toMatchObject({ reason: "stopped", ...mode.forced });
    });

  test.runIf(mode.polite)(
    "a retained tree that ends on the polite stop is never forced",
    async () => {
      const proc = spawnRawSupervised({
        ...mode.ports,
        command: process.execPath,
        args: ["-e", "console.log('ready'); setInterval(() => {}, 1000);"],
        env: {},
        name: "polite",
        killGroupOnExit: false,
      });
      await once(proc.stdout, "data");
      expect(await proc.stop({ graceMs: 5_000 })).toMatchObject({ signal: "SIGTERM" });
    },
  );

  for (const retained of [false, true])
    test(`a forced stop overtakes a polite stop's long grace${retained ? " when retained" : ""}`, async () => {
      const proc = await stubbornChild(mode.ports, retained);
      const polite = proc.stop({ graceMs: 60_000 });
      const began = performance.now();
      await stopOwnedGroups(100);
      await polite;
      expect(performance.now() - began).toBeLessThan(5_000);
      expect(await proc.exited).toMatchObject(mode.forced);
    });

  test("a later, longer stop never delays the force an earlier stop scheduled", async () => {
    const proc = await stubbornChild(mode.ports);
    const began = performance.now();
    void proc.stop({ graceMs: 100 });
    await proc.stop({ graceMs: 60_000 });
    expect(performance.now() - began).toBeLessThan(5_000);
  });

  test("output beyond its budget ends the tree", async () => {
    const proc = spawnRawSupervised({
      ...mode.ports,
      command: process.execPath,
      args: ["-e", "while (true) console.log('x'.repeat(100));"],
      env: {},
      name: "flood",
      maxOutputBytes: 4096,
    });
    expect((await proc.exited).reason).toBe("output-limit");
  });

  test("a byte stream reports its exit code, and stopping one ends a running child", async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-tree-bytes-"));
    try {
      const done = spawnBytes({
        ...mode.ports,
        command: process.execPath,
        args: ["-e", "process.exit(3)"],
        cwd: root,
        env: { ...process.env },
      });
      await expect(done.exited).resolves.toBe(3);
      const running = spawnBytes({
        ...mode.ports,
        command: process.execPath,
        args: ["-e", `console.log('ready'); ${stubborn}`],
        cwd: root,
        env: { ...process.env },
      });
      await once(running.stdout, "data");
      await running.stop();
      // POSIX reports the kill as a signal (no code); taskkill /F leaves exit code 1.
      await expect(running.exited).resolves.toBe(windowsHost ? 1 : null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a retained tree leaves the process journal once its stop completes", async () => {
    const added: number[] = [];
    const removed: number[] = [];
    const stopObserving = observeProcessGroups({
      add: (pid) => void added.push(pid),
      remove: (pid) => void removed.push(pid),
    });
    try {
      const proc = await stubbornChild(mode.ports, true);
      expect(added).toContain(proc.pid);
      await proc.stop({ graceMs: 50 });
      expect(removed).toContain(proc.pid);
    } finally {
      stopObserving();
    }
  });
});

test.skipIf(windowsHost)("a contained tree releases its job when ownership ends", async () => {
  const ports = { platform: "win32", killTree: signalLeader } as const;
  const natural = fakeJob();
  const proc = spawnSupervised({
    ...ports,
    jobFactory: natural.factory,
    command: process.execPath,
    args: ["-e", ""],
    env: {},
    name: "contained",
  });
  await proc.exited;
  expect(natural.job).toEqual({ joined: 1, released: true });
  const retained = fakeJob();
  const service = await stubbornChild({ ...ports, jobFactory: retained.factory }, true);
  await service.stop({ graceMs: 50 });
  expect(retained.job).toEqual({ joined: 1, released: true });
});

test.runIf(windowsHost)("a real batch shim preserves arguments through cmd parsing", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-native-batch-"));
  try {
    const record = join(root, "argv.json");
    const command = join(root, "agent shim.cmd");
    await writeFile(
      command,
      '@echo off\r\n"%ACE_NODE%" -e "require(\'node:fs\').writeFileSync(process.env.ACE_RECORD, JSON.stringify(process.argv.slice(1)))" %*\r\n',
    );
    const args = ["a&b", "%PATH%", "two words", "雪"];
    const proc = spawnSupervised({
      command,
      args,
      env: { ACE_NODE: process.execPath, ACE_RECORD: record },
      cwd: root,
      name: "batch",
    });
    expect(await proc.exited).toMatchObject({ code: 0, reason: "exit" });
    expect(z.array(z.string()).parse(JSON.parse(await readFile(record, "utf8")))).toEqual(args);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owner exit runs each owned group's platform destroy", async () => {
  // Negative-pid signals are invalid on Windows, so the exit hook runs the
  // destroy each owner registered instead of assuming a process group.
  const root = await mkdtemp(join(tmpdir(), "ace-owner-exit-"));
  try {
    const receipt = join(root, "destroyed");
    const moduleUrl = new URL("./process-owner.ts", import.meta.url).href;
    const script = `import {registerGroup} from ${JSON.stringify(moduleUrl)};
import {writeFileSync} from "node:fs";
registerGroup(424242, () => Promise.resolve(), {name:"test-destroy"}, () => { writeFileSync(${JSON.stringify(receipt)}, "destroyed"); });
process.exit(0);`;
    const owner = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: "ignore",
    });
    expect(await once(owner, "close")).toEqual([0, null]);
    expect(await readFile(receipt, "utf8")).toBe("destroyed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
