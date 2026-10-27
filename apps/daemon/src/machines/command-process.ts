import type { Readable, Writable } from "node:stream";
import { OutputTail, type CommandOutcome } from "./command-rules.ts";

/** A spawned command whose whole process tree `stop` ends (provider-kit's supervised spawn). */
export interface CommandProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stop(options?: { graceMs?: number }): Promise<unknown>;
}
export type CommandSpawner = (spec: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}) => CommandProcess;

export interface RunningCommand {
  stdout: OutputTail;
  stderr: OutputTail;
  startedAt: number;
  /** Settles once the command and every process it started have ended. */
  done: Promise<CommandOutcome>;
  /** Ends the whole tree; `done` then reports it stopped. */
  stop(): void;
}

export interface CommandClock {
  now(): number;
  /** Runs `run` after `ms`; the returned function cancels it. */
  schedule(ms: number, run: () => void): () => void;
}

/** Settles once a stream has nothing more to give. */
function closed(stream: Readable): Promise<void> {
  return new Promise((resolve) => {
    if (stream.destroyed || stream.readableEnded) resolve();
    else stream.once("close", () => resolve());
  });
}

/** How long a stopped tree gets to exit after its polite signal. */
const graceMs = 2_000;

/**
 * Runs one command line in its own process tree. It reads no input, keeps the last `tailBytes`
 * of each stream, and stops the whole tree at its timeout or on `stop`.
 */
export function runCommand(
  spawn: CommandSpawner,
  clock: CommandClock,
  spec: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv },
  limits: { timeoutMs: number; tailBytes: number },
): RunningCommand {
  const stdout = new OutputTail(limits.tailBytes);
  const stderr = new OutputTail(limits.tailBytes);
  const startedAt = clock.now();
  const proc = spawn(spec);
  proc.stdin.on("error", () => undefined);
  proc.stdin.end();
  proc.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  proc.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  let ending: "timedOut" | "stopped" | undefined;
  let stopping: Promise<unknown> | undefined;
  const end = (why: "timedOut" | "stopped") => {
    ending ??= why;
    stopping ??= proc.stop({ graceMs }).catch(() => undefined);
  };
  const cancelTimer = clock.schedule(limits.timeoutMs, () => end("timedOut"));
  const done = (async (): Promise<CommandOutcome> => {
    let exit: { code: number | null; signal: NodeJS.Signals | null };
    try {
      exit = await proc.exited;
    } finally {
      cancelTimer();
    }
    await Promise.all([closed(proc.stdout), closed(proc.stderr), stopping]);
    return {
      exitCode: ending ? null : exit.code,
      signal: exit.signal,
      timedOut: ending === "timedOut",
      stopped: ending === "stopped",
      durationMs: clock.now() - startedAt,
    };
  })();
  return { stdout, stderr, startedAt, done, stop: () => end("stopped") };
}
