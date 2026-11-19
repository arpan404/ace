import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  observeProcessGroups,
  spawnRawSupervised,
  spawnSupervised,
  type SpawnOptions,
} from "./process.ts";
import { spawnBytes } from "./process-bytes.ts";
import { stopOwnedGroups } from "./process-owner.ts";

const windowsHost = process.platform === "win32";
const stubborn = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";

/** A Job Object stand-in whose release is observable. */
function fakeJob() {
  const job = { released: false };
  const factory = () => ({
    assign: () => {},
    dispose: () => void (job.released = true),
  });
  return { job, factory };
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

type Ports = Pick<SpawnOptions, "windowsJobFactory">;

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
async function stubbornChild(ports: Ports, retained = false) {
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

describe.runIf(windowsHost)("an owned Windows tree", () => {
  // taskkill /F leaves exit code 1; Windows console children cannot be asked to close.
  const forced = { signal: null };
  test("a clean exit keeps its final output and status", async () => {
    const proc = spawnSupervised({
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
      const proc = await stubbornChild({}, retained);
      const exit = await proc.stop({ graceMs: 50 });
      expect(exit).toMatchObject({ reason: "stopped", ...forced });
    });

  for (const retained of [false, true])
    test(`a forced stop overtakes a polite stop's long grace${retained ? " when retained" : ""}`, async () => {
      const proc = await stubbornChild({}, retained);
      const polite = proc.stop({ graceMs: 60_000 });
      const began = performance.now();
      await stopOwnedGroups(100);
      await polite;
      expect(performance.now() - began).toBeLessThan(5_000);
      expect(await proc.exited).toMatchObject(forced);
    });

  test("a later, longer stop never delays the force an earlier stop scheduled", async () => {
    const proc = await stubbornChild({});
    const began = performance.now();
    void proc.stop({ graceMs: 100 });
    await proc.stop({ graceMs: 60_000 });
    expect(performance.now() - began).toBeLessThan(5_000);
  });

  test("output beyond its budget ends the tree", async () => {
    const proc = spawnRawSupervised({
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
        command: process.execPath,
        args: ["-e", "process.exit(3)"],
        cwd: root,
        env: { ...process.env },
      });
      await expect(done.exited).resolves.toBe(3);
      const running = spawnBytes({
        command: process.execPath,
        args: ["-e", `console.log('ready'); ${stubborn}`],
        cwd: root,
        env: { ...process.env },
      });
      await once(running.stdout, "data");
      await running.stop();
      // taskkill /F leaves exit code 1.
      await expect(running.exited).resolves.toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a retained tree's stop completes only once every member is gone", async () => {
    const proc = spawnRawSupervised({
      command: process.execPath,
      args: [
        "-e",
        "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});" +
          `console.log(JSON.stringify([process.pid,c.pid])); ${stubborn}`,
      ],
      env: {},
      name: "retained-tree",
      killGroupOnExit: false,
    });
    const [chunk] = await once(proc.stdout, "data");
    const members = z.array(z.number()).parse(JSON.parse(String(chunk)));
    await proc.stop({ graceMs: 50 });
    // Checked at once: a stop that returned after only requesting the kill would see survivors.
    expect(members.filter(isRunning)).toEqual([]);
  });

  test("a retained tree leaves the process journal once its stop completes", async () => {
    const added: number[] = [];
    const removed: number[] = [];
    const stopObserving = observeProcessGroups({
      add: (pid) => void added.push(pid),
      remove: (pid) => void removed.push(pid),
    });
    try {
      const proc = await stubbornChild({}, true);
      expect(added).toContain(proc.pid);
      await proc.stop({ graceMs: 50 });
      expect(removed).toContain(proc.pid);
    } finally {
      stopObserving();
    }
  });
});

test.runIf(windowsHost)("a contained tree releases its job when ownership ends", async () => {
  const natural = fakeJob();
  const proc = spawnSupervised({
    windowsJobFactory: natural.factory,
    command: process.execPath,
    args: ["-e", ""],
    env: {},
    name: "contained",
  });
  await proc.exited;
  expect(natural.job).toEqual({ released: true });
  const retained = fakeJob();
  const service = await stubbornChild({ windowsJobFactory: retained.factory }, true);
  await service.stop({ graceMs: 50 });
  expect(retained.job).toEqual({ released: true });
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
    const args = [
      "a&b",
      "%PATH%",
      "two words",
      "雪",
      "x^y",
      'say "hi" & echo pwned',
      "C:\\my dir\\",
      "",
      "last",
    ];
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
