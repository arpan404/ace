import { describe, expect, test } from "vitest";
import { setImmediate } from "node:timers/promises";
import type { RetainedJob } from "@ace/provider-kit/process-containment";
import { TerminalManager, createConptyBackendFactory, createPosixBackendFactory } from "./index.ts";
import type { ConptyNative, NativePty, ShutdownScheduler, ProcessControl } from "./index.ts";

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
  const rows = [
    { pid: 42, group: 42, state: "R", owner },
    { pid: 41, group: 42, state: "R", owner },
  ];
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
    async signalOwned(group, signal) {
      if (!rows.some((row) => row.group === group && row.owner === owner && row.state !== "Z"))
        return false;
      processes.signal(group, signal);
      return true;
    },
    read: async () => rows.map((row) => ({ ...row })),
    signal(group, signal) {
      if (signal === "SIGTERM") termSeen();
      if (signal !== "SIGKILL" || unkillable) return;
      // A still-running job can fork when the reserved group is killed too early.
      if (group === 42 && rows.some((row) => row.group !== 42 && row.state === "R"))
        rows.push({ pid: 45, group: 45, state: "R", owner });
      for (const row of rows) if (row.group === group) row.state = "Z";
      if (group === 42) onExit({ exitCode: 0, signal: 9 });
    },
  };
  const manager = new TerminalManager({
    graceMs,
    dependencies: {
      backendFactory: createPosixBackendFactory({
        spawn: () => native,
        processes,
        createLease: () => ({
          path: "/controlled-fifo",
          readyPath: "/controlled-ready",
          ready: () => true,
          alive: () => true,
          dispose: noop,
        }),
      }),
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
  const anchor = context.rows[1];
  if (anchor) anchor.state = "Z";
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
  await context.manager.closeAll();
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

test("an orphan in a recycled session is never mistaken for an exited terminal", async () => {
  const context = boundary(0);
  context.exit({ exitCode: 0 });
  // A reused numeric session ID can be present even after its new leader exits.
  context.rows.splice(0, context.rows.length, { pid: 43, group: 43, state: "R", owner });
  await context.manager.closeAll();
  expect(context.rows[0]?.state).toBe("R");
});

/** ConPTY with its Job Object faked at the native boundary; runs on any host. */
function conpty({ unkillable = false, assignFails = false, disposeFails = false } = {}) {
  let onExit: (input: unknown) => void = noop;
  let onData: (input: unknown) => void = noop;
  const state = { live: false, contained: false, shellKilled: false, spawnEnv: {} as object };
  let failAssign = assignFails;
  let failDispose = disposeFails;
  let canKill = !unkillable;
  const native: ConptyNative = {
    pid: 42,
    write: (data) => {
      // A dead console echoes nothing; loop back only while contained.
      if (state.live) onData(Buffer.from(data, "utf8"));
    },
    resize: noop,
    kill: () => {
      state.shellKilled = true;
    },
    onData(listener) {
      onData = listener;
      return { dispose: noop };
    },
    onExit(listener) {
      onExit = listener;
      return { dispose: noop };
    },
  };
  const job: RetainedJob = {
    assign: () => {
      if (failAssign) throw new Error("Windows job assignment failed");
      state.contained = true;
    },
    activeCount: () => (state.live && state.contained ? 1 : 0),
    terminate: () => {
      // Termination kills the tree, which surfaces as an exit event.
      if (!canKill) return;
      state.live = false;
      onExit({ exitCode: 1 });
    },
    dispose: () => {
      if (!failDispose) return;
      failDispose = false;
      throw new Error("Windows handle close failed");
    },
  };
  const manager = new TerminalManager({
    graceMs: 0,
    dependencies: {
      backendFactory: createConptyBackendFactory({
        spawn: (_file, _args, options) => {
          state.live = true;
          state.shellKilled = false;
          state.spawnEnv = options?.env ?? {};
          return native;
        },
        createJob: () => job,
      }),
      createSessionId: () => owner,
      resolveShell: () => "C:\\Windows\\System32\\cmd.exe",
      shutdownScheduler: { now: () => 0, delay: async () => {} },
    },
  });
  const open = (env?: Record<string, string | undefined>) =>
    manager.openTerminal({
      cwd: "C:\\work",
      cols: 80,
      rows: 24,
      name: "conpty",
      ...(env ? { env } : {}),
    });
  return {
    manager,
    state,
    open,
    exit: (input: unknown) => onExit(input),
    data: (input: unknown) => onData(input),
    repair: () => {
      canKill = true;
      state.live = false;
    },
    heal: () => {
      failAssign = false;
    },
  };
}

async function readUntil(terminal: ReturnType<ReturnType<typeof conpty>["open"]>, text: string) {
  const attachment = terminal.attach();
  let output = "";
  while (!output.includes(text)) {
    const event = await attachment.next();
    if (event.done || event.value.type !== "data") throw new Error("Terminal ended early");
    output += event.value.data;
  }
  attachment.detach();
}

describe("a ConPTY terminal", () => {
  test("the shell runs directly with its full environment, preload included", async () => {
    const context = conpty();
    const terminal = context.open({ NODE_OPTIONS: "--require probe" });
    expect(terminal.snapshot().shell).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(context.state.spawnEnv).toMatchObject({ NODE_OPTIONS: "--require probe" });
    await context.manager.closeAll();
  });

  test("writes reach the console and resizes persist", async () => {
    const context = conpty();
    const terminal = context.open();
    terminal.write("echo hello\r");
    await readUntil(terminal, "echo hello");
    terminal.resize(120, 40);
    expect(terminal.snapshot()).toMatchObject({ cols: 120, rows: 40 });
    await context.manager.closeAll();
  });

  test("split-byte buffers and string frames decode without dividing characters", async () => {
    const context = conpty();
    const attachment = context.open().attach();
    const bytes = Buffer.from("😀é終", "utf8");
    context.data(bytes.subarray(0, 2));
    context.data(bytes.subarray(2, 5));
    context.data(bytes.subarray(5));
    context.data(" — done 😀");
    context.exit({ exitCode: 0 });
    const events = [];
    for await (const event of attachment) events.push(event);
    const text = events.map((event) => (event.type === "data" ? event.data : "")).join("");
    expect(text).toBe("😀é終 — done 😀");
    expect(events.at(-1)).toMatchObject({ type: "exit", status: { code: 0, signal: null } });
    await context.manager.closeAll();
  });

  test("shell exit keeps ownership until close confirms the job is empty", async () => {
    const context = conpty();
    const terminal = context.open();
    context.exit({ exitCode: 23 });
    expect(await terminal.exited).toEqual({ code: 23, signal: null });
    expect(terminal.ownsProcesses).toBe(true);
    await context.manager.closeAll();
    expect(terminal.ownsProcesses).toBe(false);
  });

  test("a surviving tree fails close but succeeds after repair", async () => {
    const context = conpty({ unkillable: true });
    const terminal = context.open();
    await expect(context.manager.closeAll()).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: expect.stringContaining("survived") })],
    });
    expect(terminal.ownsProcesses).toBe(true);
    context.repair();
    await context.manager.closeAll();
    expect(terminal.ownsProcesses).toBe(false);
  });

  test("a shell that cannot join the job is stopped and admission fails", async () => {
    const context = conpty({ assignFails: true });
    expect(() => context.open()).toThrow("assignment failed");
    expect(context.state.shellKilled).toBe(true);
    context.heal();
    const terminal = context.open();
    await context.manager.closeAll();
    expect(terminal.ownsProcesses).toBe(false);
  });

  test("a non-SIGKILL kill is an explicit error and leaves the console running", async () => {
    const context = conpty();
    const terminal = context.open();
    await expect(terminal.kill("SIGTERM")).rejects.toThrow("do not support");
    terminal.write("still here\r");
    await readUntil(terminal, "still here");
    await context.manager.closeAll();
    expect(terminal.ownsProcesses).toBe(false);
  });

  test("a failed handle close retains ownership for retry", async () => {
    const context = conpty({ disposeFails: true });
    const terminal = context.open();
    await expect(context.manager.closeAll()).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: expect.stringContaining("close failed") })],
    });
    expect(terminal.ownsProcesses).toBe(true);
    await context.manager.closeAll();
    expect(terminal.ownsProcesses).toBe(false);
  });
});
