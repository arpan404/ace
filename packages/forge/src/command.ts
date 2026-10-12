import { spawn } from "node:child_process";
import { ForgeError } from "./errors.ts";
import { LogTail } from "./tail.ts";

export type CommandRequest = {
  command: string;
  args: readonly string[];
  input?: string;
  signal: AbortSignal;
  mode: "json" | "tail";
  /** Passed only to the actual write, never to identity probes. */
  dispatch?: { prepare?(): void; record(): void };
};
export type CommandResult = {
  code: number | null;
  stdout: string;
  truncated: boolean;
  identityChanged?: true;
};
export type CommandRunner = (request: CommandRequest) => Promise<CommandResult>;

/** Byte-oriented shell: provider-kit's readline probes cannot bound an oversized line.
 * No stderr, argv, environment or raw errors escape this boundary. */
export function createCommandRunner(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBytes?: number;
}): CommandRunner {
  const maxBytes = options.maxBytes ?? 4_194_304;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  )
    throw new RangeError("Invalid command limits");
  return async (request) => {
    if (request.signal.aborted) throw new ForgeError("cancelled", undefined, false);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...options.env,
      GH_PROMPT_DISABLED: "1",
      GH_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
    };
    delete env.GH_DEBUG;
    delete env.DEBUG;
    request.dispatch?.prepare?.();
    const launch = () => spawn(request.command, [...request.args], {
      cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let child: ReturnType<typeof launch>;
    try {
      child = launch();
    } catch {
      throw new ForgeError("cli", undefined, false);
    }
    let failure: ForgeError | undefined;
    const stop = () => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
    };
    const abort = () => {
      failure = new ForgeError("cancelled");
      stop();
    };
    request.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      failure = new ForgeError("cli");
      stop();
    }, timeoutMs);
    const chunks: Buffer[] = [];
    const tail = new LogTail();
    let bytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      if (request.mode === "tail") {
        tail.write(chunk);
        return;
      }
      bytes += chunk.length;
      if (bytes > maxBytes) {
        failure = new ForgeError("limit");
        stop();
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    try {
      const code = await new Promise<number | null>((resolve) => {
        child.once("error", () => {
          failure = new ForgeError("cli", undefined, child.pid === undefined ? false : undefined);
        });
        child.once("exit", stop);
        child.once("close", resolve);
        // spawn has synchronously admitted a child when it exposes a PID. Before any await
        // or stdin delivery, record that it may contact the remote, even if it later times out.
        if (child.pid !== undefined) request.dispatch?.record();
        child.stdin.end(request.input);
      });
      if (failure) throw failure;
      const output =
        request.mode === "tail"
          ? tail.finish()
          : { text: Buffer.concat(chunks, bytes).toString("utf8"), truncated: false };
      return { code, stdout: output.text, truncated: output.truncated };
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
      stop();
    }
  };
}
