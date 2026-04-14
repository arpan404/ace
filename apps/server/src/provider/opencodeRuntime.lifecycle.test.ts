import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  setOpenCodeRuntimeDependencies,
  startOpenCodeServer,
  startOpenCodeServerIsolated,
} from "./opencodeRuntime";

function makeRunningServerProcess(url: string, pid: number): ChildProcess {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = Object.assign(new EventEmitter() as ChildProcess, {
    pid,
    exitCode: null,
    signalCode: null,
    stdout: stdout as unknown as ChildProcess["stdout"],
    stderr: stderr as unknown as ChildProcess["stderr"],
    kill: vi.fn(() => true),
  });

  setTimeout(() => {
    stdout.emit("data", Buffer.from(`opencode server listening on ${url}\n`));
  }, 0);

  return child;
}

function emitProcessExit(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  Object.assign(child, { signalCode: signal });
  setTimeout(() => {
    child.emit("exit", null, signal);
  }, 0);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startOpenCodeServer", () => {
  it("reuses a shared OpenCode server until the final lease closes", async () => {
    const pid = 1234;
    const child = makeRunningServerProcess("http://127.0.0.1:4011", pid);
    const spawnMock = vi.fn(() => child);
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    const restoreDependencies = setOpenCodeRuntimeDependencies({
      spawn: spawnMock as unknown as typeof import("node:child_process").spawn,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    let processGroupAlive = true;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((targetPid, signal) => {
      if (targetPid === -pid) {
        if (signal === 0) {
          if (!processGroupAlive) {
            const error = Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
            throw error;
          }
          return true;
        }
        if (signal === "SIGTERM" || signal === "SIGKILL") {
          processGroupAlive = false;
          emitProcessExit(child, signal as NodeJS.Signals);
        }
      }
      return true;
    }) as typeof process.kill);

    try {
      const first = await startOpenCodeServer("/bin/opencode");
      const second = await startOpenCodeServer("/bin/opencode");

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(first.url).toBe("http://127.0.0.1:4011");
      expect(second.url).toBe(first.url);

      await first.close();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(killSpy).not.toHaveBeenCalled();

      await second.close();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(killSpy).toHaveBeenCalledWith(-pid, "SIGTERM");
    } finally {
      restoreDependencies();
    }
  });

  it("falls back to stopping the process when graceful disposal fails", async () => {
    const pid = 5678;
    const child = makeRunningServerProcess("http://127.0.0.1:4012", pid);
    const spawnMock = vi.fn(() => child);
    const fetchMock = vi.fn(async () => {
      throw new Error("dispose failed");
    });
    const restoreDependencies = setOpenCodeRuntimeDependencies({
      spawn: spawnMock as unknown as typeof import("node:child_process").spawn,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    let processGroupAlive = true;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((targetPid, signal) => {
      if (targetPid === -pid) {
        if (signal === 0) {
          if (!processGroupAlive) {
            const error = Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
            throw error;
          }
          return true;
        }
        if (signal === "SIGTERM" || signal === "SIGKILL") {
          processGroupAlive = false;
          emitProcessExit(child, signal as NodeJS.Signals);
        }
      }
      return true;
    }) as typeof process.kill);

    try {
      const handle = await startOpenCodeServer("/bin/opencode");
      await expect(handle.close()).resolves.toBeUndefined();

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(killSpy).toHaveBeenCalledWith(-pid, "SIGTERM");
    } finally {
      restoreDependencies();
    }
  });

  it("kills the detached process group even when the launcher already exited", async () => {
    const pid = 7810;
    const child = makeRunningServerProcess("http://127.0.0.1:4013", pid);
    const spawnMock = vi.fn(() => child);
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    const restoreDependencies = setOpenCodeRuntimeDependencies({
      spawn: spawnMock as unknown as typeof import("node:child_process").spawn,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    let processGroupAlive = true;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((targetPid, signal) => {
      if (targetPid === -pid) {
        if (signal === 0) {
          if (!processGroupAlive) {
            const error = Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
            throw error;
          }
          return true;
        }
        if (signal === "SIGTERM" || signal === "SIGKILL") {
          processGroupAlive = false;
          return true;
        }
      }
      return true;
    }) as typeof process.kill);

    try {
      const handle = await startOpenCodeServer("/bin/opencode");
      Object.assign(child, { exitCode: 0 });

      await expect(handle.close()).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(killSpy).toHaveBeenCalledWith(-pid, 0);
      expect(killSpy).toHaveBeenCalledWith(-pid, "SIGTERM");
    } finally {
      restoreDependencies();
    }
  });
});

describe("startOpenCodeServerIsolated", () => {
  it("creates dedicated server processes for concurrent sessions", async () => {
    const firstPid = 9011;
    const secondPid = 9012;
    const firstChild = makeRunningServerProcess("http://127.0.0.1:5011", firstPid);
    const secondChild = makeRunningServerProcess("http://127.0.0.1:5012", secondPid);
    const spawnMock = vi.fn().mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    const restoreDependencies = setOpenCodeRuntimeDependencies({
      spawn: spawnMock as unknown as typeof import("node:child_process").spawn,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    const processGroupAliveByPid = new Map<number, boolean>([
      [firstPid, true],
      [secondPid, true],
    ]);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((targetPid, signal) => {
      if (targetPid === -firstPid) {
        if (signal === 0) {
          if (!processGroupAliveByPid.get(firstPid)) {
            const error = Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
            throw error;
          }
          return true;
        }
        if (signal === "SIGTERM" || signal === "SIGKILL") {
          processGroupAliveByPid.set(firstPid, false);
          emitProcessExit(firstChild, signal as NodeJS.Signals);
        }
      }
      if (targetPid === -secondPid) {
        if (signal === 0) {
          if (!processGroupAliveByPid.get(secondPid)) {
            const error = Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
            throw error;
          }
          return true;
        }
        if (signal === "SIGTERM" || signal === "SIGKILL") {
          processGroupAliveByPid.set(secondPid, false);
          emitProcessExit(secondChild, signal as NodeJS.Signals);
        }
      }
      return true;
    }) as typeof process.kill);

    try {
      const first = await startOpenCodeServerIsolated("/bin/opencode");
      const second = await startOpenCodeServerIsolated("/bin/opencode");

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(first.url).toBe("http://127.0.0.1:5011");
      expect(second.url).toBe("http://127.0.0.1:5012");

      await first.close();
      await second.close();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(killSpy).toHaveBeenCalledWith(-firstPid, "SIGTERM");
      expect(killSpy).toHaveBeenCalledWith(-secondPid, "SIGTERM");
    } finally {
      restoreDependencies();
    }
  });
});
