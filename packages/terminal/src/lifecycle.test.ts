import { expect, test } from "vitest";
import { setImmediate } from "node:timers/promises";
import { TerminalManager, createPosixBackendFactory } from "./index.ts";
import type { NativePty, ShutdownScheduler, ProcessControl } from "./index.ts";

const owner = "7c48b6c8-ef6f-4ef6-9441-ff1a406fc885";
const foreign = "2c48b6c8-ef6f-4ef6-9441-ff1a406fc885";
function noop() {}

function boundary(graceMs = 37, unkillable = false) {
  let onExit: (input: unknown) => void = noop;
  let onData: (input: unknown) => void = noop;
  let now = 0;
  let release: () => void = noop;
  let waiting: () => void = noop;
  const scheduled = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  let deadline = Infinity;
  const scheduler: ShutdownScheduler = {
    now: () => now,
    delay(ms) {
      if (ms === 0) return Promise.resolve();
      deadline = now + ms;
      waiting();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  };
  const rows = [{ pid: 42, group: 42, state: "R", owner }];
  let termSeen = noop;
  const stopping = new Promise<void>((resolve) => {
    termSeen = resolve;
  });
  const native: NativePty = {
    pid: 42,
    write() {},
    resize() {},
    onData(listener) {
      onData = listener;
      return { dispose() {} };
    },
    onExit(listener) {
      onExit = listener;
      return { dispose() {} };
    },
  };
  const processes: ProcessControl = {
    read: async () => rows.map((row) => ({ ...row })),
    signal(group, signal) {
      if (signal === "SIGTERM") termSeen();
      if (signal !== "SIGKILL" || unkillable) return;
      for (const row of rows) if (row.group === group) row.state = "Z";
      if (group === 42) onExit({ exitCode: 0, signal: 9 });
    },
  };
  const manager = new TerminalManager({
    graceMs,
    dependencies: {
      backendFactory: createPosixBackendFactory({ spawn: () => native, processes }),
      createSessionId: () => owner,
      resolveShell: () => "/test-shell",
      shutdownScheduler: scheduler,
    },
  });
  const terminal = manager.openTerminal({
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    name: "controlled boundary",
  });
  return {
    manager,
    terminal,
    rows,
    scheduled,
    stopping,
    advance(ms: number) {
      now += ms;
      if (now >= deadline) release();
    },
    exit(input: unknown) {
      onExit(input);
    },
    data(input: unknown) {
      onData(input);
    },
  };
}

test("SIGKILL waits for the configured grace deadline and discovers jobs born during grace", async () => {
  const context = boundary();
  const closing = context.manager.closeAll();
  await context.stopping;
  await setImmediate();
  context.rows.push({ pid: 43, group: 43, state: "R", owner });
  context.advance(36);
  await Promise.resolve();
  expect(context.terminal.snapshot().exit).toBeNull();
  expect(context.rows.every((row) => row.state === "R")).toBe(true);
  context.advance(1);
  await closing;
  expect(await context.terminal.exited).toEqual({ code: 0, signal: 9 });
  expect(context.rows.every((row) => row.state === "Z")).toBe(true);
});

test("process churn cannot keep shutdown waiting indefinitely", async () => {
  const context = boundary(0, true);
  context.exit({ exitCode: 0 });
  await expect(context.manager.closeAll()).rejects.toThrow("shutdown");
  expect(context.rows[0]?.state).toBe("R");
});

test("an exit delivered during backend subscription retains its status", async () => {
  const manager = new TerminalManager({
    graceMs: 0,
    dependencies: {
      backendFactory: () => ({
        pid: 42,
        write: noop,
        resize: noop,
        onData: () => noop,
        onExit(listener) {
          listener({ code: 19, signal: null });
          return noop;
        },
        kill: async () => {},
        close: async () => {},
      }),
    },
  });
  const terminal = manager.openTerminal({ cwd: "/tmp", cols: 80, rows: 24, name: "instant exit" });
  expect(await terminal.exited).toEqual({ code: 19, signal: null });
  expect((await terminal.attach().next()).value).toMatchObject({
    type: "exit",
    status: { code: 19 },
  });
  await manager.closeAll();
});

test("a reused process group without current ownership is never killed", async () => {
  const context = boundary();
  const closing = context.manager.closeAll();
  await context.scheduled;
  context.exit({ exitCode: 0 });
  const row = context.rows[0];
  if (!row) throw new Error("Missing process");
  row.owner = foreign;
  context.advance(37);
  await closing;
  expect(row.state).toBe("R");
  expect(await context.terminal.exited).toEqual({ code: 0, signal: null });
});

test("malformed native exit status rejects lifecycle and a pending watcher", async () => {
  const context = boundary(0);
  const watcher = context.terminal.attach();
  const read = watcher.next();
  const exitAssertion = expect(context.terminal.exited).rejects.toThrow();
  const readAssertion = expect(read).rejects.toThrow();
  context.exit({ exitCode: "invalid", signal: -1 });
  await Promise.all([exitAssertion, readAssertion]);
  expect(() => context.terminal.snapshot()).toThrow();
  await expect(context.manager.closeAll()).rejects.toThrow();
});

test("explicit release drops replay handles while other terminals stay usable", async () => {
  const context = boundary(0);
  context.data(Buffer.from("retained output"));
  context.exit({ exitCode: 7 });
  expect((await context.terminal.attach().next()).value).toMatchObject({ data: "retained output" });
  await context.manager.release(context.terminal);
  expect(() => context.terminal.attach()).toThrow("released");
  expect(() => context.terminal.snapshot()).toThrow("released");
  const next = context.manager.openTerminal({ cwd: "/tmp", cols: 80, rows: 24, name: "next" });
  context.exit({ exitCode: 0 });
  expect(await next.exited).toEqual({ code: 0, signal: null });
  await context.manager.closeAll();
});
