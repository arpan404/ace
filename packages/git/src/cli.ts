import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { stat } from "node:fs/promises";
import { z } from "zod";
import { count, decode } from "./decode.ts";
import { GitError, toGitError, type GitOptions } from "./types.ts";

interface CallOptions {
  write?: boolean;
  env?: Record<string, string>;
  input?: Buffer | string;
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

  constructor(options: GitOptions) {
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

  async call(cwd: string, args: string[], options: CallOptions = {}): Promise<Output> {
    if (args.some((arg) => arg.includes("\0"))) {
      throw new GitError("invalid_argument", "Git arguments cannot contain NUL bytes");
    }
    this.ready ??= this.verify(cwd);
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
      const child = spawn(this.binary, ["--no-pager", ...args], {
        cwd,
        env,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [];
      const errors: Buffer[] = [];
      const limit = options.captureBytes ?? 64 * 1024 * 1024;
      let captured = 0;
      let errorBytes = 0;
      let truncated = false;
      let failure: GitError | undefined;
      let spawnFailure: Promise<GitError> | undefined;
      const kill = () => {
        if (child.pid && process.platform !== "win32") {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        } else {
          child.kill("SIGKILL");
        }
      };
      const timer = setTimeout(() => {
        failure = new GitError("git_timeout", `Git exceeded ${this.timeoutMs}ms`, { args });
        kill();
      }, this.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        if (options.consume) {
          try {
            options.consume(chunk);
          } catch (error) {
            failure = toGitError(error);
            kill();
          }
          return;
        }
        const remaining = Math.max(0, limit - captured);
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        captured += Math.min(remaining, chunk.length);
        if (chunk.length > remaining) {
          truncated = true;
          if (options.captureBytes === undefined) {
            failure = new GitError("output_too_large", "Git metadata exceeded 64 MiB", { args });
            kill();
          }
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const keep = Math.min(chunk.length, Math.max(0, 65_536 - errorBytes));
        if (keep) errors.push(chunk.subarray(0, keep));
        errorBytes += keep;
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        spawnFailure = classifySpawn(error, cwd, this.binary);
      });
      child.on("close", async (code) => {
        clearTimeout(timer);
        if (spawnFailure) failure = await spawnFailure;
        const stderr = Buffer.concat(errors).toString("utf8");
        if (failure) return reject(failure);
        if (code !== 0 && !options.allowFailure) {
          return reject(new GitError("git_failed", stderr.trim() || "Git failed", { args, code }));
        }
        resolve({ stdout: Buffer.concat(chunks), stderr, exitCode: code ?? -1, truncated });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(options.input);
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
