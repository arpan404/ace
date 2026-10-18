/*
 * The daemon's side of `ace-screen-helper --computer`: JSON lines over stdin/stdout.
 * The helper starts on first use and restarts after it exits or stops answering, so a hung
 * app or a helper crash costs one failed call, never the feature.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { ComputerReply } from "./wire.ts";

export class ComputerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ComputerClientOptions {
  /** The installed helper executable; resolved before every start. */
  helper: () => Promise<string>;
  nextId: () => string;
  /** Starts the helper. Tests substitute a fake process. */
  spawnHelper?: (command: string, args: readonly string[]) => ChildProcessWithoutNullStreams;
  /** How long each op may take before the helper is presumed stuck and replaced. */
  deadlineMs?: (op: string) => number;
}

interface Pending {
  /** The helper this request was written to; only its exit fails the request. */
  child: ChildProcessWithoutNullStreams;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cancel: () => void;
}

const maxReplyBytes = 32 * 1024 * 1024;

/** Launching, settling and capturing take seconds; a batch of actions takes longest. */
export function defaultDeadlineMs(op: string): number {
  return op === "act" ? 85_000 : op === "state" ? 40_000 : 20_000;
}

export class ComputerClient {
  private process: ChildProcessWithoutNullStreams | undefined;
  private starting: Promise<ChildProcessWithoutNullStreams> | undefined;
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  private readonly options: ComputerClientOptions;

  constructor(options: ComputerClientOptions) {
    this.options = options;
  }

  async request(
    op: string,
    payload: Record<string, unknown>,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<unknown> {
    if (this.closed) throw new ComputerError("closed", "Computer use is shutting down.");
    signal?.throwIfAborted();
    const child = await this.start();
    const id = this.options.nextId();
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(
        () => {
          this.pending.delete(id);
          reject(
            new ComputerError(
              "timeout",
              "The app did not respond in time (it may be busy or stuck on a dialog). Try again; if it keeps failing, take a screenshot to see what it is showing.",
            ),
          );
          // A stuck helper blocks every later call; start a fresh one next time.
          this.stop(child);
        },
        (this.options.deadlineMs ?? defaultDeadlineMs)(op),
      );
      const onAbort = () => {
        this.pending.get(id)?.cancel();
        this.pending.delete(id);
        reject(signal?.reason ?? new Error("Aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        child,
        resolve,
        reject,
        cancel: () => {
          clearTimeout(deadline);
          signal?.removeEventListener("abort", onAbort);
        },
      });
      child.stdin.write(`${JSON.stringify({ ...payload, op, id })}\n`, (error) => {
        if (error)
          this.failAll(
            child,
            new ComputerError("helper_exited", "The computer-use helper stopped. Try again."),
          );
      });
    });
  }

  private start(): Promise<ChildProcessWithoutNullStreams> {
    if (this.process && this.process.exitCode === null && !this.process.killed)
      return Promise.resolve(this.process);
    this.starting ??= (async () => {
      try {
        const command = await this.options.helper();
        const child = (this.options.spawnHelper ?? defaultSpawn)(command, ["--computer"]);
        this.attach(child);
        this.process = child;
        return child;
      } finally {
        this.starting = undefined;
      }
    })();
    return this.starting;
  }

  private attach(child: ChildProcessWithoutNullStreams): void {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (Buffer.byteLength(line) > maxReplyBytes) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      const reply = ComputerReply.safeParse(parsed);
      if (!reply.success) return;
      const waiter = this.pending.get(reply.data.id);
      if (!waiter) return;
      this.pending.delete(reply.data.id);
      waiter.cancel();
      if (reply.data.ok) waiter.resolve(reply.data.result);
      else waiter.reject(new ComputerError(reply.data.error.code, reply.data.error.message));
    });
    child.stderr.resume();
    child.on("error", () =>
      this.failAll(
        child,
        new ComputerError("helper_unavailable", "The computer-use helper could not start."),
      ),
    );
    child.on("exit", () =>
      this.failAll(
        child,
        new ComputerError("helper_exited", "The computer-use helper stopped. Try again."),
      ),
    );
  }

  private failAll(child: ChildProcessWithoutNullStreams, error: ComputerError): void {
    if (this.process === child) this.process = undefined;
    for (const [id, waiter] of this.pending) {
      if (waiter.child !== child) continue;
      waiter.cancel();
      waiter.reject(error);
      this.pending.delete(id);
    }
  }

  private stop(child: ChildProcessWithoutNullStreams): void {
    if (this.process === child) this.process = undefined;
    child.stdin.end();
    child.kill("SIGTERM");
  }

  close(): void {
    this.closed = true;
    if (this.process) this.stop(this.process);
  }
}

function defaultSpawn(command: string, args: readonly string[]): ChildProcessWithoutNullStreams {
  return spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
}
