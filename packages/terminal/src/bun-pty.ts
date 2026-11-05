import { constants } from "node:os";

/**
 * A pseudo-terminal from Bun's own `Bun.spawn({ terminal })`, shaped like the part of node-pty
 * the terminal backends use. node-pty's native addon needs Node's libuv loop: under Bun it spawns
 * the shell but never reports output or exit, so the daemon uses this when it runs on Bun.
 */
export interface SpawnedPty {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (input: unknown) => void): { dispose(): void };
  onExit(listener: (input: unknown) => void): { dispose(): void };
}

export interface PtySpawnOptions {
  cwd?: string | undefined;
  cols?: number | undefined;
  rows?: number | undefined;
  env?: Record<string, string | undefined> | undefined;
  /**
   * How long exit waits, after the shell exits, for the terminal's end of output. A background
   * process can hold the terminal open forever; its output after that is not the shell's.
   */
  outputGraceMs?: number | undefined;
}

/** Output held before the first listener subscribes, at most (the newest bytes are kept). */
const pendingLimit = 4 * 1024 * 1024;
const defaultOutputGraceMs = 2_000;

interface BunTerminal {
  write(data: string): number;
  resize(cols: number, rows: number): void;
}
interface BunSubprocess {
  readonly pid: number;
  readonly terminal?: BunTerminal | undefined;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  kill(signal?: string): void;
}
export interface BunRuntime {
  spawn(
    command: string[],
    options: {
      cwd?: string | undefined;
      env?: Record<string, string> | undefined;
      windowsVerbatimArguments?: boolean | undefined;
      terminal: {
        cols: number;
        rows: number;
        data(terminal: unknown, bytes: Uint8Array): void;
        /** The terminal's output ended (EOF or a read error), apart from the process exit. */
        exit(terminal: unknown): void;
      };
    },
  ): BunSubprocess;
}

function hasSpawn(value: unknown): value is BunRuntime {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "spawn") === "function"
  );
}

/** Bun's runtime object when this process runs on Bun, otherwise undefined. */
export function bunRuntime(): BunRuntime | undefined {
  const bun: unknown = Reflect.get(globalThis, "Bun");
  return hasSpawn(bun) ? bun : undefined;
}

/** node-pty's exit event: a signal death reports exit code 0 and the signal's number. */
function exitEvent(child: BunSubprocess, code: number): { exitCode: number; signal: number } {
  const name = child.signalCode;
  if (name === null) return { exitCode: child.exitCode ?? code, signal: 0 };
  const signal: unknown = Reflect.get(constants.signals, name);
  return { exitCode: 0, signal: typeof signal === "number" ? signal : 0 };
}

export function spawnBunPty(
  runtime: BunRuntime,
  file: string,
  args: string[] | string,
  options: PtySpawnOptions,
): SpawnedPty {
  const dataListeners = new Set<(input: unknown) => void>();
  const exitListeners = new Set<(input: unknown) => void>();
  // Output that arrives before the first listener subscribes is held, not dropped.
  let pending: Uint8Array[] | undefined = [];
  let pendingBytes = 0;
  const hold = (bytes: Uint8Array) => {
    if (!pending) return;
    pending.push(bytes);
    pendingBytes += bytes.byteLength;
    while (pendingBytes > pendingLimit && pending.length > 1)
      pendingBytes -= pending.shift()?.byteLength ?? 0;
  };
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env ?? process.env))
    if (value !== undefined) env[key] = value;
  // Exit is reported once the shell has exited and the terminal's output has ended, so the
  // last bytes the shell wrote reach listeners first; the two arrive separately.
  let outputEnded = false;
  let exitCode: number | undefined;
  let reported = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  const report = () => {
    if (reported || exitCode === undefined) return;
    reported = true;
    if (grace) clearTimeout(grace);
    const exit = exitEvent(child, exitCode);
    for (const listener of exitListeners) listener(exit);
  };
  // A string is a Windows command line, passed on as written (node-pty does the same). The
  // program path leads it unquoted, so it must contain no spaces.
  const verbatim = typeof args === "string";
  if (verbatim && /\s/.test(file))
    throw new Error(`A Windows terminal program path cannot contain spaces: ${file}`);
  const child = runtime.spawn(verbatim ? [file, args] : [file, ...args], {
    cwd: options.cwd,
    env,
    windowsVerbatimArguments: verbatim || undefined,
    terminal: {
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      data(_terminal, bytes) {
        if (pending) hold(bytes);
        else for (const listener of dataListeners) listener(bytes);
      },
      exit() {
        outputEnded = true;
        // Data callbacks already queued run before the exit does.
        setImmediate(report);
      },
    },
  });
  const terminal = child.terminal;
  if (!terminal) {
    child.kill("SIGKILL");
    throw new Error("Bun did not attach a terminal to the shell");
  }
  void child.exited.then((code) => {
    exitCode = code;
    if (outputEnded) setImmediate(report);
    else grace = setTimeout(report, options.outputGraceMs ?? defaultOutputGraceMs);
  });
  return {
    pid: child.pid,
    write: (data) => {
      terminal.write(data);
    },
    resize: (cols, rows) => terminal.resize(cols, rows),
    kill: () => child.kill(process.platform === "win32" ? undefined : "SIGHUP"),
    onData(listener) {
      dataListeners.add(listener);
      if (pending) {
        const held = pending;
        pending = undefined;
        pendingBytes = 0;
        for (const bytes of held) listener(bytes);
      }
      return { dispose: () => dataListeners.delete(listener) };
    },
    onExit(listener) {
      exitListeners.add(listener);
      return { dispose: () => exitListeners.delete(listener) };
    },
  };
}
