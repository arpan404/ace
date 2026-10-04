import { z } from "zod";
import { Readable, type Writable } from "node:stream";
import { killTree, processRuntime } from "./process-runtime.ts";
import { StringDecoder } from "node:string_decoder";
import { stat } from "node:fs/promises";
import { GitDiagnostics } from "./diagnostics.ts";
import { count, decode } from "./decode.ts";
import { GitError, toGitError, type GitOptions, type GitProcessRuntime } from "./types.ts";

interface CallOptions {
  write?: boolean;
  env?: Record<string, string>;
  input?: Buffer | string | Readable;
  output?: Writable;
  allowFailure?: boolean;
  captureBytes?: number;
  consume?: (chunk: Buffer) => void;
}

export interface Output {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

export class GitCli {
  readonly binary: string;
  readonly timeoutMs: number;
  private ready: Promise<void> | undefined;
  private readonly runtime: GitProcessRuntime;
  private readonly calls = new Set<Promise<Output>>();
  private readonly cancellations = new Set<() => void>();
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(options: GitOptions) {
    this.runtime = processRuntime(options.processRuntime);
    this.binary = options.gitBinary ?? "git";
    if (!this.binary || this.binary.includes("\0")) {
      throw new GitError("invalid_argument", "gitBinary must name an executable");
    }
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs <= 0 ||
      this.timeoutMs > 2_147_483_647
    ) {
      throw new GitError(
        "invalid_argument",
        "timeoutMs must be an integer between 1 and 2147483647",
      );
    }
  }

  get activeCalls(): number {
    return this.calls.size;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const cancel of this.cancellations) cancel();
    this.closing = Promise.allSettled(this.calls).then(() => {});
    return this.closing;
  }
  call(cwd: string, args: string[], options: CallOptions = {}): Promise<Output> {
    if (this.closed) return Promise.reject(new GitError("git_closed", "Git service closed"));
    if (this.calls.size >= 64)
      return Promise.reject(new GitError("git_busy", "Git call limit reached"));
    const result = this.runCall(cwd, args, options);
    this.calls.add(result);
    void result.then(
      () => this.calls.delete(result),
      () => this.calls.delete(result),
    );
    return result;
  }
  /** Cancellable I/O-bound retry pause, using the same injected clock as calls. */
  pause(milliseconds: number): Promise<void> {
    if (this.closed) return Promise.reject(new GitError("git_closed", "Git service closed"));
    return new Promise((resolve, reject) => {
      const cancelled = () => {
        stop();
        this.cancellations.delete(cancelled);
        reject(new GitError("git_closed", "Git service closed"));
      };
      const stop = this.runtime.scheduleTimeout(() => {
        this.cancellations.delete(cancelled);
        resolve();
      }, milliseconds);
      this.cancellations.add(cancelled);
    });
  }
  private async runCall(cwd: string, args: string[], options: CallOptions): Promise<Output> {
    if (args.some((arg) => arg.includes("\0"))) {
      throw new GitError("invalid_argument", "Git arguments cannot contain NUL bytes");
    }
    this.ready ??= this.verify(cwd).catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    await this.ready;
    return this.execute(cwd, args, options);
  }

  private async verify(cwd: string): Promise<void> {
    const result = await this.execute(cwd, ["--version"], {});
    const version = /^git version (\d+)\.(\d+)\.(\d+)/.exec(textOutput(result));
    const [major, minor] = version
      ? decode(z.tuple([z.string(), z.string(), z.string()]), version.slice(1), "version").map(
          count,
        )
      : [0, 0];
    if (
      !version ||
      major === undefined ||
      minor === undefined ||
      major < 2 ||
      (major === 2 && minor < 40)
    ) {
      throw new GitError("git_too_old", "ace requires Git 2.40 or newer", {
        binary: this.binary,
        version: result.stdout.toString().trim(),
      });
    }
  }

  private execute(cwd: string, args: string[], options: CallOptions): Promise<Output> {
    if (this.closed) return Promise.reject(new GitError("git_closed", "Git service closed"));
    // Repository/index selectors inherited from an agent must not redirect our commands.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    );
    Object.assign(env, {
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      ...(options.write ? {} : { GIT_OPTIONAL_LOCKS: "0" }),
      ...options.env,
    });
    return new Promise((resolve, reject) => {
      const child = this.runtime.spawn(this.binary, ["--no-pager", ...args], {
        cwd,
        env,
        shell: false,
        detached: this.runtime.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [];
      const errors: Buffer[] = [];
      const limit = options.captureBytes ?? 64 * 1024 * 1024;
      let captured = 0;
      let errorBytes = 0;
      const diagnostics = new GitDiagnostics();
      let truncated = false;
      let failure: GitError | undefined;
      let spawnFailure: Promise<GitError> | undefined;
      let stopping: Promise<void> | undefined;
      const kill = () => {
        stopping ??= killTree(this.runtime, child);
      };
      const cancel = () => {
        failure ??= new GitError("git_closed", "Git service closed");
        kill();
      };
      this.cancellations.add(cancel);
      const fail = (error: unknown) => {
        if (failure) return;
        failure = toGitError(error);
        kill();
      };
      const cancelDeadline = this.runtime.scheduleTimeout(() => {
        fail(new GitError("git_timeout", `Git exceeded ${this.timeoutMs}ms`, { args }));
      }, this.timeoutMs);
      const streamFailure = (error: Error) => fail(error);
      child.stdout.on("error", streamFailure);
      child.stderr.on("error", streamFailure);
      if (options.output) {
        options.output.on("error", streamFailure);
        child.stdout.pipe(options.output);
      }
      const stdout = (chunk: Buffer) => {
        if (options.output) return;
        if (options.consume) {
          try {
            options.consume(chunk);
          } catch (error) {
            fail(error);
          }
          return;
        }
        const remaining = Math.max(0, limit - captured);
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        captured += Math.min(remaining, chunk.length);
        if (chunk.length > remaining) {
          truncated = true;
          if (options.captureBytes === undefined) {
            fail(new GitError("output_too_large", "Git metadata exceeded 64 MiB", { args }));
          }
        }
      };
      const stderrData = (chunk: Buffer) => {
        diagnostics.accept(chunk);
        const keep = Math.min(chunk.length, Math.max(0, 65_536 - errorBytes));
        if (keep) errors.push(Buffer.from(chunk.subarray(0, keep)));
        errorBytes += keep;
      };
      child.stdout.on("data", stdout);
      child.stderr.on("data", stderrData);
      const spawnError = (error: NodeJS.ErrnoException) => {
        spawnFailure = classifySpawn(error, cwd, this.binary);
      };
      child.on("error", spawnError);
      child.once("close", async (code) => {
        cancelDeadline();
        this.cancellations.delete(cancel);
        if (stopping) await stopping;
        if (options.input instanceof Readable) {
          options.input.unpipe(child.stdin);
          options.input.off("error", streamFailure);
        }
        if (options.output) {
          child.stdout.unpipe(options.output);
          options.output.off("error", streamFailure);
        }
        child.stdout.off("data", stdout);
        child.stderr.off("data", stderrData);
        child.stdout.off("error", streamFailure);
        child.stderr.off("error", streamFailure);
        child.off("error", spawnError);
        if (spawnFailure) failure ??= await spawnFailure;
        const stderr = Buffer.concat(errors).toString("utf8");
        if (failure) return reject(failure);
        if (code !== 0 && !options.allowFailure) {
          return reject(new GitError(diagnostics.finish(), "Git command failed", { code }));
        }
        resolve({ stdout: Buffer.concat(chunks), stderr, exitCode: code ?? -1, truncated });
      });
      child.stdin.on("error", () => {});
      if (options.input instanceof Readable) {
        options.input.on("error", streamFailure);
        options.input.pipe(child.stdin);
      } else child.stdin.end(options.input);
      if (this.closed) cancel();
    });
  }
}

async function classifySpawn(
  error: NodeJS.ErrnoException,
  cwd: string,
  binary: string,
): Promise<GitError> {
  if (error.code === "ENOENT") {
    try {
      await stat(cwd);
    } catch {
      return new GitError("not_a_repo", `Git working directory no longer exists: ${cwd}`);
    }
  }
  return new GitError(
    error.code === "ENOENT" ? "git_missing" : "git_failed",
    error.code === "ENOENT" ? `Git binary not found: ${binary}` : error.message,
    { binary },
  );
}

export function textOutput(output: Output): string {
  // Scalar plumbing output ends with one newline; paths are parsed only from -z formats.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(output.stdout).replace(/\n$/, "");
  } catch {
    throw new GitError("malformed_output", "Malformed Git UTF-8 scalar");
  }
}

export function patchOutput(output: Output): string {
  const decoder = new StringDecoder("utf8");
  const text = decoder.write(output.stdout);
  return output.truncated ? text : text + decoder.end();
}
