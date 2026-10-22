import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import type { RetainedWindowsJob } from "@ace/provider-kit/windows-job";
import { TerminalManager, createWindowsBackendFactory } from "./index.ts";
import type { ShutdownScheduler } from "./index.ts";
import type { WindowsNativePty } from "./index.ts";

const owner = "7c48b6c8-ef6f-4ef6-9441-ff1a406fc885";
const SHELL = "C:\\Windows\\System32\\cmd.exe";
function noop() {}

function hasPreload(env: Record<string, string | undefined>): boolean {
  return Object.keys(env).some((key) => key.toLowerCase() === "node_options");
}

function boundary({
  unkillable = false,
  assignFails = false,
  disposeFails = false,
  releaseFails = false,
  createFails = false,
  cleanupFails = false,
  preload,
}: {
  unkillable?: boolean;
  assignFails?: boolean;
  disposeFails?: boolean;
  releaseFails?: boolean;
  createFails?: boolean;
  cleanupFails?: boolean;
  preload?: boolean;
} = {}) {
  let onExit: (input: unknown) => void = noop;
  let onData: (input: unknown) => void = noop;
  let exitedFired = false;
  const fireExit = (input: unknown) => {
    if (exitedFired) return;
    exitedFired = true;
    onExit(input);
  };
  let live = true;
  let canKill = !unkillable;
  let failAssign = assignFails;
  let failCreate = createFails;
  let failCleanup = cleanupFails;
  let disposedOnce = false;
  const assigned = new Set<number>();
  let now = 0;
  const scheduler: ShutdownScheduler = {
    now: () => now,
    delay: async () => {},
  };
  const native: WindowsNativePty = {
    pid: 42,
    write: (data) => {
      // A dead console echoes nothing; loop back only while contained.
      if (live) onData(Buffer.from(data, "utf8"));
    },
    resize() {},
    kill() {},
    onData(listener) {
      onData = listener;
      return { dispose: noop };
    },
    onExit(listener) {
      onExit = listener;
      return { dispose: noop };
    },
  };
  const job: RetainedWindowsJob = {
    assign: (pid) => {
      if (!Number.isInteger(pid) || pid <= 0) throw new Error("Windows job assignment failed");
      if (failAssign) throw new Error("Windows job assignment failed");
      assigned.add(pid);
    },
    activeCount: () => (live ? 1 : 0),
    terminate: () => {
      // Termination kills the tree, which surfaces as an exit event.
      if (canKill) {
        live = false;
        fireExit({ exitCode: 1 });
      }
    },
    dispose: () => {
      if (disposeFails && !disposedOnce) {
        disposedOnce = true;
        throw new Error("Windows handle close failed");
      }
    },
  };
  const manager = new TerminalManager({
    graceMs: 0,
    dependencies: {
      backendFactory: createWindowsBackendFactory(
        {
          spawn: (file, argv, options) => {
            live = true;
            exitedFired = false;
            // The bootstrap image is the only permitted spawn target, on the
            // dll path, with preload vectors neutralized for any spelling.
            if (file !== process.execPath) throw new Error("refuses raw shell spawn");
            if (!("useConptyDll" in options) || options.useConptyDll !== true)
              throw new Error("requires the scan-free ConPTY path");
            if (hasPreload(options.env ?? {})) throw new Error("bootstrap preload not neutralized");
            if (argv.length !== 3 || !(argv[0] ?? "").endsWith(".mjs"))
              throw new Error("unmaterialized gate");
            return native;
          },
          createRetainedJob: () => {
            if (failCreate) throw new Error("Windows job creation failed");
            return job;
          },
          prepareGate: (init) => {
            // The shell keeps its full environment, preload vectors included.
            if (preload !== undefined && hasPreload(init.env) !== preload)
              throw new Error("shell preload env not preserved");
            return {
              script: "/gate/gate.mjs",
              argv: ["/gate/config.json", "/gate/release"],
              init,
              release: () => {
                // The shell must not exist before containment.
                if (!assigned.has(42)) throw new Error("released before containment");
                if (releaseFails) throw new Error("Windows gate release failed");
              },
              cleanup: () => {
                if (failCleanup) throw new Error("gate cleanup failed");
              },
            };
          },
        },
        "/gate-root",
      ),
      createSessionId: () => owner,
      resolveShell: () => SHELL,
      shutdownScheduler: scheduler,
    },
  });
  return {
    manager,
    exit: (input: unknown) => fireExit(input),
    data: (input: unknown) => onData(input),
    repair: () => {
      canKill = true;
      live = false;
    },
    healAdmission: () => {
      failAssign = false;
      failCreate = false;
      failCleanup = false;
    },
  };
}

function open(
  options?: Parameters<typeof boundary>[0] & { env?: Record<string, string | undefined> },
) {
  const { env, ...rest } = options ?? {};
  const context = boundary(rest);
  const terminal = context.manager.openTerminal({
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    name: "win32",
    ...(env ? { env } : {}),
  });
  return { ...context, terminal };
}

test("the default gate materializes parseable ESM and cleans up after close", async () => {
  const root = mkdtempSync(join(tmpdir(), "ace-gate-check-"));
  let script = "";
  try {
    let emitExit: (input: unknown) => void = noop;
    let live = true;
    const manager = new TerminalManager({
      graceMs: 0,
      dependencies: {
        backendFactory: createWindowsBackendFactory(
          {
            spawn: (_file, argv) => {
              script = argv[0] ?? "";
              return {
                pid: 42,
                write: noop,
                resize: noop,
                kill: noop,
                onData: () => ({ dispose: noop }),
                onExit: (listener) => {
                  emitExit = listener;
                  return { dispose: noop };
                },
              };
            },
            createRetainedJob: () => ({
              assign: noop,
              activeCount: () => (live ? 1 : 0),
              terminate: () => {
                live = false;
                emitExit({ exitCode: 1 });
              },
              dispose: noop,
            }),
          },
          root,
        ),
        createSessionId: () => owner,
        resolveShell: () => SHELL,
        shutdownScheduler: { now: () => 0, delay: async () => {} },
      },
    });
    const terminal = manager.openTerminal({ cwd: "/tmp", cols: 80, rows: 24, name: "win32" });
    expect(script.endsWith(".mjs")).toBe(true);
    expect(existsSync(script)).toBe(true);
    await promisify(execFile)(process.execPath, ["--check", script]);
    await manager.closeAll();
    expect(terminal.ownsProcesses).toBe(false);
    expect(existsSync(script)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the bootstrap image admits the terminal with a neutralized environment", async () => {
  const context = open({ env: { NODE_OPTIONS: "--require evil", Node_Options: "--import x" } });
  expect(context.terminal.pid).toBe(42);
  expect(context.terminal.snapshot().shell).toBe(SHELL);
  await context.manager.closeAll();
});

test("writes reach the console and resizes persist", async () => {
  const context = open();
  const attachment = context.terminal.attach();
  context.terminal.write("echo hello\r");
  let output = "";
  for (;;) {
    const event = await attachment.next();
    if (event.done || event.value.type !== "data") throw new Error("Terminal ended early");
    output += event.value.data;
    if (output.includes("echo hello")) break;
  }
  context.terminal.resize(120, 40);
  expect(context.terminal.snapshot()).toMatchObject({ cols: 120, rows: 40 });
  expect(() => context.terminal.resize(0, 40)).toThrow(RangeError);
  expect(context.terminal.snapshot()).toMatchObject({ cols: 120, rows: 40 });
  await context.manager.closeAll();
});

test("split-byte buffers and string frames decode without dividing characters", async () => {
  const context = open();
  const attachment = context.terminal.attach();
  // Byte frames may divide a code point; the ring retains the suffix until
  // its remaining bytes arrive. ConPTY string frames always carry complete
  // code points (utf8-decoded upstream), so no split-surrogate case exists.
  const bytes = Buffer.from("😀é終", "utf8");
  context.data(bytes.subarray(0, 2));
  context.data(bytes.subarray(2, 5));
  context.data(bytes.subarray(5));
  context.data(" — done 😀");
  context.exit({ exitCode: 0 });
  const events = [];
  for await (const event of attachment) events.push(event);
  const text = events
    .filter((event) => event.type === "data")
    .map((event) => (event.type === "data" ? event.data : ""))
    .join("");
  expect(text).toBe("😀é終 — done 😀");
  expect(events.at(-1)).toMatchObject({ type: "exit", status: { code: 0, signal: null } });
  await context.manager.closeAll();
});

test("shell exit keeps ownership until close confirms the job is empty", async () => {
  const context = open();
  context.exit({ exitCode: 23 });
  expect(await context.terminal.exited).toEqual({ code: 23, signal: null });
  expect(context.terminal.ownsProcesses).toBe(true);
  await context.manager.closeAll();
  expect(context.terminal.ownsProcesses).toBe(false);
});

test("a surviving tree fails close but succeeds after repair", async () => {
  const context = open({ unkillable: true });
  await expect(context.manager.closeAll()).rejects.toMatchObject({
    errors: [expect.objectContaining({ message: expect.stringContaining("survived") })],
  });
  expect(context.terminal.ownsProcesses).toBe(true);
  context.repair();
  await context.manager.closeAll();
  expect(context.terminal.ownsProcesses).toBe(false);
});

test("malformed native exit rejects lifecycle but permits releasing stopped history", async () => {
  const context = open();
  const watcher = context.terminal.attach();
  const read = watcher.next();
  const exitAssertion = expect(context.terminal.exited).rejects.toThrow();
  const readAssertion = expect(read).rejects.toThrow();
  context.exit({ exitCode: "invalid" });
  await Promise.all([exitAssertion, readAssertion]);
  expect(() => context.terminal.snapshot()).toThrow();
  await context.manager.closeAll();
});

test("assignment failure fails admission instead of proceeding uncontained", async () => {
  const context = boundary({ assignFails: true });
  expect(() =>
    context.manager.openTerminal({ cwd: "/tmp", cols: 80, rows: 24, name: "win32" }),
  ).toThrow("assignment failed");
  context.healAdmission();
  const terminal = context.manager.openTerminal({
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    name: "win32",
  });
  await context.manager.closeAll();
  expect(terminal.ownsProcesses).toBe(false);
});

test("release failure fails admission while the manager stays usable", async () => {
  const failing = boundary({ releaseFails: true });
  expect(() =>
    failing.manager.openTerminal({ cwd: "/tmp", cols: 80, rows: 24, name: "win32" }),
  ).toThrow("release failed");
  const context = open();
  await context.manager.closeAll();
  expect(context.terminal.ownsProcesses).toBe(false);
});

test("job creation failure cleans up independently and preserves the primary error", async () => {
  const context = boundary({ createFails: true, cleanupFails: true });
  let failure: unknown;
  try {
    context.manager.openTerminal({ cwd: "/tmp", cols: 80, rows: 24, name: "win32" });
  } catch (error) {
    failure = error;
  }
  if (!(failure instanceof AggregateError))
    throw new Error("Expected containment cleanup failures");
  expect(failure.errors[0]).toMatchObject({
    message: expect.stringContaining("creation failed"),
  });
  context.healAdmission();
  const terminal = context.manager.openTerminal({
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    name: "win32",
  });
  await context.manager.closeAll();
  expect(terminal.ownsProcesses).toBe(false);
});

async function withInheritedPreload(run: () => Promise<void>): Promise<void> {
  const saved = process.env.NODE_OPTIONS;
  const had = "NODE_OPTIONS" in process.env;
  process.env.NODE_OPTIONS = "--require probe";
  try {
    await run();
  } finally {
    if (had) process.env.NODE_OPTIONS = saved;
    else delete process.env.NODE_OPTIONS;
  }
}

test("an inherited preload stays with the shell while the bootstrap is neutralized", async () => {
  await withInheritedPreload(async () => {
    const context = boundary({ preload: true });
    const terminal = context.manager.openTerminal({
      cwd: "/tmp",
      cols: 80,
      rows: 24,
      name: "win32",
    });
    expect(terminal.ownsProcesses).toBe(true);
    await context.manager.closeAll();
    expect(terminal.ownsProcesses).toBe(false);
  });
});

test("a case-variant mask removes the inherited preload", async () => {
  await withInheritedPreload(async () => {
    const context = boundary({ preload: false });
    const terminal = context.manager.openTerminal({
      cwd: "/tmp",
      cols: 80,
      rows: 24,
      name: "win32",
      env: { Node_Options: undefined },
    });
    expect(terminal.pid).toBe(42);
    await context.manager.closeAll();
    expect(terminal.ownsProcesses).toBe(false);
  });
});

test("a non-SIGKILL kill is an explicit error, not a silent force-kill", async () => {
  const context = open();
  const attachment = context.terminal.attach();
  await expect(context.terminal.kill("SIGTERM")).rejects.toThrow("do not support");
  expect(context.terminal.ownsProcesses).toBe(true);
  // The console is still alive: input keeps flowing.
  context.terminal.write("still here\r");
  let output = "";
  for (;;) {
    const event = await attachment.next();
    if (event.done || event.value.type !== "data") throw new Error("Terminal ended early");
    output += event.value.data;
    if (output.includes("still here")) break;
  }
  await context.manager.closeAll();
  expect(context.terminal.ownsProcesses).toBe(false);
});

test("a failed handle close retains ownership for retry", async () => {
  const context = open({ disposeFails: true });
  await expect(context.manager.closeAll()).rejects.toMatchObject({
    errors: [expect.objectContaining({ message: expect.stringContaining("close failed") })],
  });
  expect(context.terminal.ownsProcesses).toBe(true);
  await context.manager.closeAll();
  expect(context.terminal.ownsProcesses).toBe(false);
});
