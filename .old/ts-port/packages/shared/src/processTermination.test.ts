import { describe, expect, it, vi } from "vitest";

import { terminateChildProcess, terminatePid } from "./processTermination";

describe("processTermination", () => {
  it("uses taskkill for Windows process trees", () => {
    const spawnSync = vi.fn(() => ({ status: 0 })) as never;
    const kill = vi.fn() as never;

    terminatePid(1234, {
      platform: "win32",
      signal: "SIGTERM",
      spawnSync,
      kill,
    });

    expect(spawnSync).toHaveBeenCalledWith("taskkill", ["/pid", "1234", "/T"], {
      stdio: "ignore",
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it("forces Windows process tree termination for SIGKILL", () => {
    const spawnSync = vi.fn(() => ({ status: 0 })) as never;

    terminatePid(1234, {
      platform: "win32",
      signal: "SIGKILL",
      spawnSync,
    });

    expect(spawnSync).toHaveBeenCalledWith("taskkill", ["/pid", "1234", "/T", "/F"], {
      stdio: "ignore",
    });
  });

  it("falls back to process.kill when taskkill is unavailable", () => {
    const spawnSync = vi.fn(() => ({ status: 1, error: new Error("missing") })) as never;
    const kill = vi.fn() as never;

    terminatePid(1234, {
      platform: "win32",
      signal: "SIGTERM",
      spawnSync,
      kill,
    });

    expect(kill).toHaveBeenCalledWith(1234, "SIGTERM");
  });

  it("uses negative pids for POSIX process group termination", () => {
    const kill = vi.fn() as never;

    terminatePid(1234, {
      platform: "linux",
      signal: "SIGTERM",
      processGroup: true,
      kill,
    });

    expect(kill).toHaveBeenCalledWith(-1234, "SIGTERM");
  });

  it("can terminate a child process tree by pid", () => {
    const child = {
      pid: 1234,
      kill: vi.fn(),
    };
    const spawnSync = vi.fn(() => ({ status: 0 })) as never;

    terminateChildProcess(child, {
      platform: "win32",
      tree: true,
      spawnSync,
    });

    expect(spawnSync).toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });
});
