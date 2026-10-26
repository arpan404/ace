import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnInteractive, type InteractiveProcess } from "./process-interactive.ts";
import { createKillOnCloseJob, type WindowsJobApi } from "./process-containment.ts";

const directories: string[] = [];
const handles: InteractiveProcess[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop({ graceMs: 0 })));
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

function track(handle: InteractiveProcess): InteractiveProcess {
  handles.push(handle);
  return handle;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await access(path);
      return;
    } catch {
      // The child has not signaled readiness yet.
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function fakeJob() {
  const assigned: number[] = [];
  let disposed = false;
  return {
    assigned,
    isDisposed: () => disposed,
    factory: () => ({
      assign: (pid: number) => {
        assigned.push(pid);
      },
      dispose: () => {
        disposed = true;
      },
    }),
  };
}

function unjoinableApi(): WindowsJobApi {
  const target = { handle: "process" };
  const job = { handle: "job" };
  return {
    create: () => job,
    setKillOnClose: () => true,
    openProcess: () => target,
    assignProcess: () => false,
    close: () => {},
    unload: () => {},
    activeCount: () => 0,
    terminate: () => {},
  };
}

describe("Windows interactive login", () => {
  it("reports a clean exit and releases its tree", async () => {
    const tree = killTree(false);
    const proc = track(
      spawnInteractive({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        env: {},
        platform: "win32",
        windowsKillTree: tree.kill,
      }),
    );
    expect(await proc.exited).toEqual({ code: 0, signal: null, reason: "exit" });
    expect(tree.calls).toHaveLength(1);
    expect(tree.calls[0]?.force).toBe(true);
  });

  it("stops the tree gracefully, then forces after the grace", async () => {
    const tree = killTree(true);
    const root = await mkdtemp(join(tmpdir(), "ace-windows-interactive-stop-"));
    directories.push(root);
    const ready = join(root, "ready");
    const proc = track(
      spawnInteractive({
        command: process.execPath,
        args: [
          "-e",
          "require('node:fs').writeFileSync(process.env.READY, 'ready');" +
            "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
        ],
        env: { READY: ready },
        platform: "win32",
        windowsKillTree: tree.kill,
      }),
    );
    await waitForFile(ready);
    const exit = await proc.stop({ graceMs: 50 });
    expect(exit).toMatchObject({ reason: "stopped" });
    expect(await proc.exited).toMatchObject({ reason: "stopped" });
    expect(tree.calls[0]).toMatchObject({ force: false });
    expect(tree.calls.some((call) => call.force)).toBe(true);
  });

  it("routes batch login entrypoints through cmd.exe with inherited stdio", async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-windows-interactive-cmd-"));
    directories.push(root);
    const record = join(root, "argv");
    await writeFile(join(root, "cmd.exe"), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$ACE_RECORD"\n', {
      mode: 0o755,
    });
    await chmod(join(root, "cmd.exe"), 0o755);
    const tree = killTree(false);
    const proc = track(
      spawnInteractive({
        command: "C:\\tools\\login.cmd",
        args: ["a&b", "%PATH%"],
        env: {
          PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
          ACE_RECORD: record,
        },
        platform: "win32",
        windowsKillTree: tree.kill,
      }),
    );
    expect(await proc.exited).toMatchObject({ code: 0, reason: "exit" });
    const lines = (await readFile(record, "utf8")).split("\n");
    expect(lines.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(lines[3]).toBe('""C:\\tools\\login.cmd" ^^^"a^^^&b^^^" ^^^"^^^%PATH^^^%^^^""');
  });

  it("reports a login CLI that fails to start", async () => {
    const tree = killTree(false);
    const proc = track(
      spawnInteractive({
        command: "ace-definitely-missing-login-binary",
        args: [],
        env: {},
        platform: "win32",
        windowsKillTree: tree.kill,
      }),
    );
    expect(await proc.exited).toMatchObject({ reason: "spawn-error" });
  });

  it("joins the Windows job and leaves it when the login ends", async () => {
    const tree = killTree(false);
    const job = fakeJob();
    const proc = track(
      spawnInteractive({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        env: {},
        platform: "win32",
        windowsKillTree: tree.kill,
        windowsJobFactory: job.factory,
      }),
    );
    expect(await proc.exited).toMatchObject({ code: 0, reason: "exit" });
    expect(job.assigned).toHaveLength(1);
    expect(job.isDisposed()).toBe(true);
  });

  it("stops the tree when the job cannot be joined", async () => {
    const tree = killTree(true);
    const root = await mkdtemp(join(tmpdir(), "ace-windows-interactive-nojob-"));
    directories.push(root);
    const ready = join(root, "ready");
    const proc = track(
      spawnInteractive({
        command: process.execPath,
        args: [
          "-e",
          "require('node:fs').writeFileSync(process.env.READY, 'ready');" +
            "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
        ],
        env: { READY: ready },
        platform: "win32",
        windowsKillTree: tree.kill,
        windowsJobFactory: () => createKillOnCloseJob(unjoinableApi),
      }),
    );
    await waitForFile(ready);
    expect(await proc.stop({ graceMs: 50 })).toMatchObject({ reason: "stopped" });
    expect(tree.calls.some((call) => call.force)).toBe(true);
  });
});

describe("POSIX interactive login", () => {
  it("reports a clean exit without a Windows tree", async () => {
    const proc = track(
      spawnInteractive({
        command: process.execPath,
        args: ["-e", "process.exit(3)"],
        env: {},
      }),
    );
    expect(await proc.exited).toEqual({ code: 3, signal: null, reason: "exit" });
  });

  it("stops its group gracefully, then forces after the grace", async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-posix-interactive-stop-"));
    directories.push(root);
    const ready = join(root, "ready");
    const proc = track(
      spawnInteractive({
        command: process.execPath,
        args: [
          "-e",
          "require('node:fs').writeFileSync(process.env.READY, 'ready');" +
            "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
        ],
        env: { READY: ready },
      }),
    );
    await waitForFile(ready);
    expect(await proc.stop({ graceMs: 50 })).toMatchObject({
      reason: "stopped",
      signal: "SIGKILL",
    });
  });
});
