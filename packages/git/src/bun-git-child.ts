import { EventEmitter } from "node:events";
import type { Writable } from "node:stream";
import {
  asBuffer,
  definedEnv,
  spawnFailure,
  type BunSink,
  type BunSpawner,
  type BunSubprocess,
} from "@ace/provider-kit/bun-spawn";
import type { GitChild, GitChildInput, GitChildOutput, GitSpawnOptions } from "./types.ts";

/**
 * Git's stdout or stderr read straight from Bun's pipe, with the parts of Node's `Readable`
 * the Git runner uses. Like a Node stream it reads only once something consumes it (a `data`
 * listener, `pipe` or `resume`), so an unread pipe applies backpressure to Git.
 */
class BunOutput extends EventEmitter implements GitChildOutput {
  #source: ReadableStream<Uint8Array> | undefined;
  #reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  #destination: Writable | undefined;
  #waiting: PromiseWithResolvers<void> | undefined;
  #closed = false;
  readonly #onClose: () => void;

  constructor(source: ReadableStream<Uint8Array> | undefined, onClose: () => void) {
    super();
    this.#source = source;
    this.#onClose = onClose;
    this.on("newListener", (event: string) => {
      if (event === "data") this.#flow();
    });
    // A failed spawn has no pipe: it closes at once, as Node's does.
    if (!source) queueMicrotask(() => this.#close());
  }

  pipe(destination: Writable): Writable {
    this.#destination = destination;
    this.#flow();
    return destination;
  }

  unpipe(destination: Writable): this {
    if (this.#destination !== destination) return this;
    this.#destination = undefined;
    this.#waiting?.resolve();
    return this;
  }

  resume(): this {
    this.#flow();
    return this;
  }

  destroy(error?: Error): this {
    if (this.#closed) return this;
    const reader = this.#reader;
    this.#source = undefined;
    this.#reader = undefined;
    this.#waiting?.resolve();
    if (reader) void reader.cancel().catch(() => {});
    process.nextTick(() => {
      if (error) this.emit("error", error);
      this.#close();
    });
    return this;
  }

  #flow(): void {
    const source = this.#source;
    if (!source || this.#reader) return;
    const reader = source.getReader();
    this.#reader = reader;
    void this.#pump(reader);
  }

  async #pump(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    for (;;) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch (error) {
        if (this.#reader === reader) this.destroy(error instanceof Error ? error : undefined);
        return;
      }
      // Destroyed while the read was pending: what it brought is discarded, as Node does.
      if (this.#reader !== reader) return;
      if (next.done) break;
      const chunk = asBuffer(next.value);
      this.emit("data", chunk);
      const destination = this.#destination;
      if (destination && !destination.write(chunk)) {
        const waiting = Promise.withResolvers<void>();
        this.#waiting = waiting;
        const drained = () => waiting.resolve();
        destination.once("drain", drained);
        destination.once("close", drained);
        await waiting.promise;
        destination.off("drain", drained);
        destination.off("close", drained);
        this.#waiting = undefined;
        if (this.#reader !== reader) return;
      }
    }
    this.#reader = undefined;
    this.#source = undefined;
    this.emit("end");
    this.#destination?.end();
    this.#close();
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.emit("close");
    this.#onClose();
  }
}

/** Git's stdin on Bun's pipe. Writes never throw: a pipe Git closed reports `error`. */
class BunInput extends EventEmitter implements GitChildInput {
  #sink: BunSink | undefined;
  #pending = 0;

  constructor(sink: BunSink | undefined) {
    super();
    this.#sink = sink;
  }

  write(chunk: Buffer | string): boolean {
    const sink = this.#sink;
    if (!sink) return true;
    return this.#track(() => sink.write(chunk));
  }

  end(chunk?: Buffer | string): this {
    const sink = this.#sink;
    if (!sink) return this;
    if (chunk !== undefined && chunk.length > 0) this.write(chunk);
    this.#sink = undefined;
    this.#track(() => sink.end());
    return this;
  }

  destroy(): this {
    const sink = this.#sink;
    this.#sink = undefined;
    if (sink) this.#track(() => sink.end(), true);
    return this;
  }

  /** True when the bytes left at once; false while Bun still queues them. */
  #track(operation: () => number | Promise<number>, quiet = false): boolean {
    const fail = (error: unknown) => {
      if (!quiet) this.emit("error", error instanceof Error ? error : new Error(String(error)));
    };
    let result: number | Promise<number>;
    try {
      result = operation();
    } catch (error) {
      process.nextTick(fail, error);
      return true;
    }
    if (typeof result === "number") return true;
    this.#pending++;
    void result.then(
      () => {
        if (--this.#pending === 0) this.emit("drain");
      },
      (error: unknown) => {
        this.#pending--;
        fail(error);
      },
    );
    return false;
  }
}

/** A Git process started by `Bun.spawn`, with the `ChildProcess` events the runner uses. */
class BunGitChild extends EventEmitter implements GitChild {
  readonly pid: number | undefined;
  readonly stdin: BunInput;
  readonly stdout: BunOutput;
  readonly stderr: BunOutput;
  #process: BunSubprocess | undefined;
  #exited = false;
  #openOutputs = 2;
  #closed = false;
  #code: number | null = null;
  #signal: NodeJS.Signals | null = null;

  constructor(spawner: BunSpawner, command: string, args: string[], options: GitSpawnOptions) {
    super();
    let child: BunSubprocess | undefined;
    let failure: NodeJS.ErrnoException | undefined;
    try {
      child = spawner.spawn([command, ...args], {
        cwd: options.cwd,
        env: definedEnv(options.env ?? process.env),
        detached: options.detached,
        windowsHide: options.windowsHide,
        stdio: options.stdio,
      });
    } catch (error) {
      failure = spawnFailure(error, command, args);
    }
    this.#process = child;
    this.pid = child?.pid;
    const outputClosed = () => {
      this.#openOutputs--;
      this.#maybeClose();
    };
    this.stdin = new BunInput(child?.stdin);
    this.stdout = new BunOutput(child?.stdout, outputClosed);
    this.stderr = new BunOutput(child?.stderr, outputClosed);
    if (!child) {
      // Node's order for a failed spawn: `error`, then `close` once the pipes have closed.
      this.#exited = true;
      process.nextTick(() => this.emit("error", failure));
      return;
    }
    process.nextTick(() => this.emit("spawn"));
    void child.exited.then(() => {
      this.#exited = true;
      this.#code = child.exitCode;
      this.#signal = child.signalCode;
      this.emit("exit", this.#code, this.#signal);
      this.#maybeClose();
    });
  }

  get exitCode(): number | null {
    return this.#code;
  }

  get signalCode(): NodeJS.Signals | null {
    return this.#signal;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    const child = this.#process;
    if (!child || this.#exited) return false;
    try {
      child.kill(signal);
      return true;
    } catch {
      return false;
    }
  }

  unref(): void {
    this.#process?.unref();
  }

  #maybeClose(): void {
    if (this.#closed || !this.#exited || this.#openOutputs > 0) return;
    this.#closed = true;
    // Deferred so `exit` listeners and final `data` run before `close`, as on Node.
    setImmediate(() => this.emit("close", this.#code, this.#signal));
  }
}

export function spawnBunGit(
  spawner: BunSpawner,
  command: string,
  args: string[],
  options: GitSpawnOptions,
): GitChild {
  return new BunGitChild(spawner, command, args, options);
}
