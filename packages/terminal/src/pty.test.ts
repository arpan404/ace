import { describe, expect, test } from "vitest";
import {
  createRetainedJob,
  type RetainedJob,
  type WindowsJobApi,
} from "@ace/provider-kit/process-containment";
import { TerminalManager, createConptyBackendFactory } from "./index.ts";
import type { ConptyNative } from "./index.ts";

// The Windows backend with ConPTY and its Job Object faked at the native boundary; runs anywhere.
const owner = "7c48b6c8-ef6f-4ef6-9441-ff1a406fc885";
function noop() {}

function conpty({
  unkillable = false,
  assignFails = false,
  disposeFails = false,
  createJob,
}: {
  unkillable?: boolean;
  assignFails?: boolean;
  disposeFails?: boolean;
  createJob?: () => RetainedJob;
} = {}) {
  let onExit: (input: unknown) => void = noop;
  let onData: (input: unknown) => void = noop;
  const state = {
    live: false,
    contained: false,
    shellKilled: false,
    spawnEnv: {} as object,
    launch: { file: "", args: "" as string | string[] },
    gate: { opened: false, closed: false, openedBeforeJoin: false },
  };
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
      state.gate.openedBeforeJoin ||= state.gate.opened;
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
    release: noop,
  };
  const manager = new TerminalManager({
    graceMs: 0,
    dependencies: {
      backendFactory: createConptyBackendFactory({
        spawn: (file, args, options) => {
          state.launch = { file, args };
          state.live = true;
          state.shellKilled = false;
          state.spawnEnv = options?.env ?? {};
          return native;
        },
        createJob: createJob ?? (() => job),
        openGate: () => ({
          path: "\\\\.\\pipe\\gate",
          open: () => void (state.gate.opened = true),
          close: () => void (state.gate.closed = true),
        }),
        launcher: "C:\\Windows\\System32\\cmd.exe",
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

describe.runIf(process.platform === "win32")("a ConPTY terminal", () => {
  test("the shell starts behind a gate that opens only once it is inside the job", async () => {
    const context = conpty();
    context.open();
    expect(context.state.launch.file).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(context.state.launch.args).toBe(
      '/d /v:off /s /c "set /p ACE_TERMINAL_GATE=<"\\\\.\\pipe\\gate" && set "ACE_TERMINAL_GATE=" && "C:\\Windows\\System32\\cmd.exe""',
    );
    expect(context.state.gate).toEqual({ opened: true, closed: false, openedBeforeJoin: false });
    await context.manager.closeAll();
    expect(context.state.gate.closed).toBe(true);
  });

  test("a failed library unload retries only the release once the job is empty", async () => {
    let unloadFails = true;
    let live = true;
    // Termination kills the tree, which surfaces as the shell's exit.
    let exit: (input: unknown) => void = noop;
    const api: WindowsJobApi = {
      create: () => "job",
      setKillOnClose: () => true,
      clearLimits: () => true,
      openProcess: () => "process",
      assignProcess: () => true,
      close: noop,
      activeCount: () => (live ? 1 : 0),
      terminate: () => {
        live = false;
        exit({ exitCode: 1 });
      },
      unload: () => {
        if (!unloadFails) return;
        unloadFails = false;
        throw new Error("Windows library unload failed");
      },
    };
    const context = conpty({ createJob: () => createRetainedJob(() => api) });
    exit = context.exit;
    const terminal = context.open();
    await expect(context.manager.closeAll()).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: expect.stringContaining("unload failed") })],
    });
    expect(terminal.ownsProcesses).toBe(true);
    await context.manager.closeAll();
    expect(terminal.ownsProcesses).toBe(false);
  });

  test("the shell runs directly with its full environment, preload included", async () => {
    const context = conpty();
    const terminal = context.open({ NODE_OPTIONS: "--require probe" });
    expect(terminal.snapshot().shell).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(context.state.spawnEnv).toMatchObject({ NODE_OPTIONS: "--require probe" });
    await context.manager.closeAll();
  });

  test("terminal overrides replace and remove inherited keys regardless of spelling", async () => {
    const context = conpty();
    context.open({ path: "C:\\override", Term: "dumb", ACE_ABSENT: undefined });
    const env = context.state.spawnEnv as Record<string, string>;
    expect(Object.keys(env).filter((key) => key.toLowerCase() === "path")).toEqual(["path"]);
    expect(env["path"]).toBe("C:\\override");
    expect(Object.keys(env).filter((key) => key.toLowerCase() === "term")).toEqual(["TERM"]);
    expect(env["TERM"]).toBe("xterm-256color");
    expect("ACE_ABSENT" in env).toBe(false);
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
    expect(context.state.gate).toMatchObject({ opened: false, closed: true });
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
