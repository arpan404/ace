import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnRawSupervised, spawnSupervised } from "./process.ts";
import { spawnBytes } from "./process-bytes.ts";
import { stopRetainedWindowsTree } from "./windows-tree.ts";

const directories: string[] = [];
const spawned: ChildProcess[] = [];
afterEach(async () => {
  for (const child of spawned.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* Already exited; the exit below still reaps it. */
    }
  }
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** A taskkill stand-in that really signals, so stops end and exits are observable. */
function killTree(recording: boolean) {
  const calls: { pid: number; force: boolean }[] = [];
  return {
    calls,
    kill(pid: number, force: boolean) {
      calls.push({ pid, force });
      if (!recording) return;
      try {
        process.kill(pid, force ? "SIGKILL" : "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    },
  };
}

describe("Windows process supervision", () => {
  it("reports a clean exit with its output intact", async () => {
    const tree = killTree(false);
    const proc = spawnSupervised({
      command: process.execPath,
      args: ["-e", "console.log('final')"],
      env: {},
      name: "test-child",
      platform: "win32",
      windowsKillTree: tree.kill,
    });
    const lines: string[] = [];
    proc.stdout.on("line", (line) => lines.push(line));
    expect(await proc.exited).toEqual({ code: 0, signal: null, reason: "exit" });
    expect(lines).toEqual(["final"]);
    expect(tree.calls).toEqual(proc.pid === undefined ? [] : [{ pid: proc.pid, force: true }]);
  });

  it("stops the tree gracefully, then forces after the grace", async () => {
    const tree = killTree(true);
    const proc = spawnSupervised({
      command: process.execPath,
      args: [
        "-e",
        "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 50);",
      ],
      env: {},
      name: "test-child",
      platform: "win32",
      windowsKillTree: tree.kill,
    });
    if (proc.pid === undefined) throw new Error("Test child failed to spawn");
    await new Promise<void>((resolve) => {
      proc.stdout.on("line", (line) => {
        if (line === "ready") resolve();
      });
    });
    const exit = await proc.stop({ graceMs: 50 });
    expect(exit).toMatchObject({ reason: "stopped" });
    expect(await proc.exited).toMatchObject({ reason: "stopped" });
    expect(tree.calls[0]).toMatchObject({ pid: proc.pid, force: false });
    expect(tree.calls.some((call) => call.force)).toBe(true);
  });

  it("kills the tree when output exceeds its budget", async () => {
    const tree = killTree(true);
    const proc = spawnRawSupervised({
      command: process.execPath,
      args: ["-e", "while (true) console.log('x'.repeat(100));"],
      env: {},
      name: "test-child",
      platform: "win32",
      windowsKillTree: tree.kill,
      maxOutputBytes: 4096,
    });
    expect((await proc.exited).reason).toBe("output-limit");
    expect(tree.calls.some((call) => call.force)).toBe(true);
    await proc.stop({ graceMs: 0 });
  });

  it("spawns batch entrypoints through cmd.exe with the quoted line", async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-windows-cmd-"));
    directories.push(root);
    const record = join(root, "argv");
    await writeFile(join(root, "cmd.exe"), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$ACE_RECORD"\n', {
      mode: 0o755,
    });
    await chmod(join(root, "cmd.exe"), 0o755);
    const tree = killTree(false);
    const proc = spawnSupervised({
      command: "C:\\tools\\agent.cmd",
      args: ["a&b", "%PATH%"],
      env: {
        PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
        ACE_RECORD: record,
      },
      name: "test-child",
      platform: "win32",
      windowsKillTree: tree.kill,
    });
    expect(await proc.exited).toMatchObject({ code: 0, reason: "exit" });
    const lines = (await readFile(record, "utf8")).split("\n");
    expect(lines.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(lines[3]).toBe('"C:\\tools\\agent.cmd "a&b" "%%PATH%%""');
  });

  it("reports a byte stream exit code on Windows supervision", async () => {
    const tree = killTree(false);
    const root = await mkdtemp(join(tmpdir(), "ace-windows-bytes-"));
    directories.push(root);
    const proc = spawnBytes({
      command: process.execPath,
      args: ["-e", "process.exit(3)"],
      cwd: root,
      env: {},
      platform: "win32",
      windowsKillTree: tree.kill,
    });
    await expect(proc.exited).resolves.toBe(3);
  });

  it("stops a byte stream tree on Windows", async () => {
    const tree = killTree(true);
    const root = await mkdtemp(join(tmpdir(), "ace-windows-bytes-"));
    directories.push(root);
    const proc = spawnBytes({
      command: process.execPath,
      args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 50);"],
      cwd: root,
      env: {},
      platform: "win32",
      windowsKillTree: tree.kill,
    });
    await proc.stop();
    await expect(proc.exited).resolves.toBeNull();
    expect(tree.calls.some((call) => call.force)).toBe(true);
  });

  it("retained Windows stops skip force when the tree exits gracefully", async () => {
    const tree = killTree(true);
    const child = spawn(
      process.execPath,
      ["-e", "console.log('ready'); setInterval(() => {}, 50);"],
      {
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    spawned.push(child);
    if (child.pid === undefined || !child.stdout) throw new Error("Test child failed to spawn");
    await once(child.stdout, "data");
    await stopRetainedWindowsTree(child.pid, 5_000, tree.kill);
    expect(tree.calls).toHaveLength(1);
    expect(tree.calls[0]?.force).toBe(false);
  });

  it("retained Windows stops force the tree after the grace", async () => {
    const tree = killTree(true);
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 50);"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    spawned.push(child);
    if (child.pid === undefined || !child.stdout) throw new Error("Test child failed to spawn");
    await once(child.stdout, "data");
    await stopRetainedWindowsTree(child.pid, 50, tree.kill);
    expect(tree.calls.map((call) => call.force)).toEqual([false, true]);
    await once(child, "exit");
  });
});
