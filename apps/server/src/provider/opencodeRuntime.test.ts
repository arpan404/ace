import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { registerParentProcessCleanup } from "./opencodeRuntime";

class FakeProcess extends EventEmitter {
  readonly platform = "darwin" as const;
}

function makeChildProcess(): ChildProcess {
  return Object.assign(new EventEmitter() as ChildProcess, {
    pid: 1234,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registerParentProcessCleanup", () => {
  it("kills the child when the parent process exits", () => {
    const child = makeChildProcess();
    const fakeProcess = new FakeProcess();

    registerParentProcessCleanup(child, fakeProcess);
    fakeProcess.emit("exit", 0);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("removes listeners after the child exits", () => {
    const child = makeChildProcess();
    const fakeProcess = new FakeProcess();

    registerParentProcessCleanup(child, fakeProcess);
    Object.assign(child, { exitCode: 0 });
    child.emit("exit", 0, null);
    fakeProcess.emit("exit", 0);

    expect(child.kill).not.toHaveBeenCalled();
    expect(fakeProcess.listenerCount("exit")).toBe(0);
    expect(fakeProcess.listenerCount("beforeExit")).toBe(0);
    expect(fakeProcess.listenerCount("disconnect")).toBe(0);
    expect(fakeProcess.listenerCount("uncaughtExceptionMonitor")).toBe(0);
  });

  it("stops cleaning up once explicitly unregistered", () => {
    const child = makeChildProcess();
    const fakeProcess = new FakeProcess();

    const unregister = registerParentProcessCleanup(child, fakeProcess);
    unregister();
    fakeProcess.emit("exit", 0);

    expect(child.kill).not.toHaveBeenCalled();
  });
});
