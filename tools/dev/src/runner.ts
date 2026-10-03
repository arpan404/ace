import { spawn, type ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";

/** One long-running development process. */
export interface ProcessSpec {
  /** Short label used as the log prefix, e.g. `daemon`. */
  name: string;
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
}

export interface GroupOptions {
  /** Where prefixed output goes. */
  output: Writable;
  /** ANSI colours for prefixes. Defaults to off. */
  color?: boolean;
  /** How long a process gets to exit after SIGTERM before it is killed. */
  graceMs?: number;
  /** Base environment for every process. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface ProcessExit {
  name: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface GroupResult {
  /** The first process that exited on its own, if any; that exit stopped the group. */
  cause?: ProcessExit;
  exits: ProcessExit[];
  /** 0 when the group was stopped on request, otherwise the first failing exit code. */
  code: number;
}

const palette = [36, 35, 33, 32, 34, 91, 96];

/** A line splitter that prefixes every complete line and flushes the remainder at the end. */
export function linePrefixer(prefix: string, write: (text: string) => void) {
  let pending = "";
  return {
    push(chunk: string) {
      const text = pending + chunk;
      const lines = text.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) write(`${prefix}${line}\n`);
    },
    flush() {
      if (pending) write(`${prefix}${pending}\n`);
      pending = "";
    },
  };
}

/**
 * Runs development processes side by side with prefixed output. Each process gets its own
 * process group, so stopping the group also stops grandchildren (Vite workers, Electron
 * helpers). The first process to exit on its own stops the rest: a dev session is all or
 * nothing.
 */
export class ProcessGroup {
  readonly done: Promise<GroupResult>;
  private children = new Map<string, ChildProcess>();
  private exits: ProcessExit[] = [];
  private cause: ProcessExit | undefined;
  private stopping = false;
  private requested = false;
  private resolve: (result: GroupResult) => void;
  private width: number;
  private options: GroupOptions;

  constructor(specs: readonly ProcessSpec[], options: GroupOptions) {
    this.options = options;
    this.width = Math.max(3, ...specs.map((spec) => spec.name.length));
    const { promise, resolve } = Promise.withResolvers<GroupResult>();
    this.done = promise;
    this.resolve = resolve;
    specs.forEach((spec, index) => this.start(spec, index));
  }

  /** Print a runner message with the runner's own prefix. */
  log(message: string): void {
    this.options.output.write(`${this.prefix("ace", 0, true)}${message}\n`);
  }

  /** Stop every process: SIGTERM to each process group, SIGKILL after the grace period. */
  stop(): Promise<GroupResult> {
    this.requested = true;
    this.terminate();
    return this.done;
  }

  /** Kill everything immediately (second Ctrl-C). */
  kill(): void {
    for (const child of this.children.values()) signal(child, "SIGKILL");
  }

  private start(spec: ProcessSpec, index: number): void {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: { ...(this.options.env ?? process.env), ...spec.env, FORCE_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      // POSIX: a new process group, so the whole tree can be signalled at once.
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.children.set(spec.name, child);
    const prefix = this.prefix(spec.name, index + 1);
    const write = (text: string) => this.options.output.write(text);
    for (const stream of [child.stdout, child.stderr]) {
      const lines = linePrefixer(prefix, write);
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => lines.push(chunk));
      stream.on("end", () => lines.flush());
    }
    child.once("error", (error) => {
      write(`${prefix}failed to start: ${error.message}\n`);
    });
    child.once("close", (code, exitSignal) => {
      this.children.delete(spec.name);
      const exit = { name: spec.name, code, signal: exitSignal };
      this.exits.push(exit);
      if (!this.stopping) {
        this.cause = exit;
        write(`${prefix}exited (${exitSignal ?? `code ${code}`}); stopping the others\n`);
        this.terminate();
      }
      if (this.children.size === 0) this.finish();
    });
  }

  private terminate(): void {
    if (this.stopping) {
      if (this.children.size === 0) this.finish();
      return;
    }
    this.stopping = true;
    if (this.children.size === 0) {
      this.finish();
      return;
    }
    for (const child of this.children.values()) signal(child, "SIGTERM");
    const timer = setTimeout(() => this.kill(), this.options.graceMs ?? 5_000);
    timer.unref();
    void this.done.then(() => clearTimeout(timer));
  }

  private finish(): void {
    const failing = this.cause && (this.cause.code !== 0 || this.cause.signal !== null);
    const code = this.requested && !this.cause ? 0 : failing ? (this.cause?.code ?? 1) : 0;
    this.resolve({ ...(this.cause ? { cause: this.cause } : {}), exits: this.exits, code });
  }

  private prefix(name: string, index: number, runner = false): string {
    const label = `${name.padEnd(this.width)} │ `;
    if (!this.options.color) return label;
    const tint = runner ? 90 : (palette[(index - 1) % palette.length] ?? 37);
    return `\u001b[${tint}m${label}\u001b[0m`;
  }
}

function signal(child: ChildProcess, name: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      // taskkill /T stops the whole tree; Windows has no process-group signals.
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else process.kill(-child.pid, name);
  } catch {
    // Already gone.
  }
}

/**
 * Runs a group until it ends or the user interrupts. The first Ctrl-C stops gracefully, a
 * second one kills. Resolves with the exit code the CLI should use.
 */
export async function runUntilInterrupted(group: ProcessGroup): Promise<number> {
  let interrupts = 0;
  const onSignal = (name: NodeJS.Signals) => {
    interrupts++;
    if (interrupts === 1) {
      group.log(`${name}: stopping…`);
      void group.stop();
    } else {
      group.log("killing");
      group.kill();
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  try {
    const result = await group.done;
    return result.code;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
  }
}
