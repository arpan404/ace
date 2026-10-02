import { expect, test } from "vitest";
import { TerminalManager, createPosixBackendFactory } from "./index.ts";
import type { NativePty, ProcessControl } from "./index.ts";

const owner = "7c48b6c8-ef6f-4ef6-9441-ff1a406fc885";
const foreign = "2c48b6c8-ef6f-4ef6-9441-ff1a406fc885";
function noop() {}

function environment() {
  let emitExit: (value: unknown) => void = noop;
  let emitData: (value: unknown) => void = noop;
  let now = 0;
  let leaseOpen = true;
  const rows = [
    { pid: 42, group: 42, owner, state: "R" },
    { pid: 41, group: 42, owner, state: "R" },
    { pid: 43, group: 43, owner, state: "R" },
  ];
  const faults = { inventory: false, afterStop: false, slowRead: false, recycleOnTerm: false };
  const processes: ProcessControl = {
    stopShell() {
      const shell = rows.find((row) => row.pid === 42);
      if (shell) shell.state = "T";
    },
    async read() {
      if (faults.inventory) throw new Error("Inventory unavailable");
      if (faults.afterStop && rows.some((row) => row.group !== 42 && row.state === "T")) {
        faults.afterStop = false;
        throw new Error("Transient inventory failure after stopping");
      }
      if (faults.slowRead) now += 1500;
      return rows.map((row) => ({ ...row }));
    },
    signal(group, signal) {
      for (const row of rows.filter((candidate) => candidate.group === group)) {
        if (signal === "SIGSTOP") row.state = "T";
        if (signal === "SIGCONT") row.state = "R";
        if (signal === "SIGKILL" || (signal === "SIGTERM" && row.owner === foreign))
          row.state = "Z";
      }
      if (group === 42 && signal === "SIGTERM" && faults.recycleOnTerm) {
        const job = rows.find((row) => row.group === 43);
        if (job) job.owner = foreign;
      }
      if (group === 42 && signal === "SIGKILL") emitExit({ exitCode: 0, signal: 9 });
    },
  };
  const native: NativePty = {
    pid: 42,
    write: noop,
    resize: noop,
    onData(listener) {
      emitData = listener;
      return { dispose: noop };
    },
    onExit(listener) {
      emitExit = listener;
      return { dispose: noop };
    },
  };
  const manager = new TerminalManager({
    graceMs: 0,
    dependencies: {
      createSessionId: () => owner,
      shutdownScheduler: { now: () => now, delay: async () => {} },
      backendFactory: createPosixBackendFactory({
        spawn: () => native,
        processes,
        createLease: () => ({
          path: "/controlled-fifo",
          readyPath: "/controlled-ready",
          ready: () => true,
          alive: () => leaseOpen,
          dispose() {
            leaseOpen = false;
          },
        }),
      }),
    },
  });
  const terminal = manager.openTerminal({ cwd: "/tmp", cols: 80, rows: 24, name: "shutdown" });
  return {
    manager,
    terminal,
    rows,
    faults,
    exit: (value: unknown) => emitExit(value),
    data: (value: Buffer) => emitData(value),
    leaseAlive: () => leaseOpen,
  };
}

test("a job group recycled between TERM signals keeps its foreign process running", async () => {
  const context = environment();
  context.faults.recycleOnTerm = true;
  await context.manager.closeAll();
  expect(context.rows.find((row) => row.owner === foreign)?.state).toBe("R");
});

test("failed inventory discovery can be repaired and manager shutdown retried", async () => {
  const context = environment();
  context.faults.inventory = true;
  await expect(context.manager.closeAll()).rejects.toThrow();
  expect(() => context.terminal.write("echo ignored\r")).toThrow("closing");
  expect(() => context.terminal.resize(100, 30)).toThrow("closing");
  expect(() =>
    context.manager.openTerminal({ cwd: "/tmp", cols: 80, rows: 24, name: "closed" }),
  ).toThrow("closed");
  context.faults.inventory = false;
  await context.manager.closeAll();
  expect(context.rows.every((row) => row.state === "Z")).toBe(true);
  expect(context.leaseAlive()).toBe(false);
  expect(() =>
    context.manager.openTerminal({ cwd: "/tmp", cols: 80, rows: 24, name: "closed" }),
  ).toThrow("closed");
});

test("an inventory failure after STOP resumes surviving owned processes before retry", async () => {
  const context = environment();
  context.faults.afterStop = true;
  await expect(context.manager.closeAll()).rejects.toThrow();
  expect(context.rows.some((row) => row.state === "T")).toBe(false);
  await context.manager.closeAll();
  expect(context.rows.every((row) => row.state === "Z")).toBe(true);
  expect(context.leaseAlive()).toBe(false);
});

test("a slow inventory still finishes killing the reserved group after its jobs", async () => {
  const context = environment();
  context.faults.slowRead = true;
  await context.manager.closeAll();
  expect(context.rows.every((row) => row.state === "Z")).toBe(true);
  expect(context.leaseAlive()).toBe(false);
});

test("malformed exit data rejects exited but does not prevent releasing stopped history", async () => {
  const context = environment();
  context.data(Buffer.from("history"));
  context.exit({ exitCode: "invalid" });
  await expect(context.terminal.exited).rejects.toThrow();
  await context.manager.release(context.terminal);
  expect(context.rows.every((row) => row.state === "Z")).toBe(true);
  expect(() => context.terminal.attach()).toThrow("released");
  expect(() => context.terminal.snapshot()).toThrow("released");
  await context.manager.closeAll();
});
