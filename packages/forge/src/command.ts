import { spawn } from "node:child_process";
import { findExecutable } from "@ace/provider-kit/discovery";
import { createKillOnCloseJob, type WindowsJob } from "@ace/provider-kit/process-containment";
import { ForgeError } from "./errors.ts";
import { LogTail } from "./tail.ts";

export type CommandRequest = {
  command: string;
  args: readonly string[];
  input?: string;
  signal: AbortSignal;
  mode: "json" | "tail";
  /** In tail mode, how many of the newest bytes are kept (16 KiB by default). */
  tailBytes?: number;
  /** Passed only to the actual write, never to identity probes. */
  dispatch?: { prepare?(): void; record(): void };
};
export type CommandResult = {
  code: number | null;
  stdout: string;
  truncated: boolean;
  identityChanged?: true;
  /** The CLI reported a network failure (DNS, refused, timed out). Stderr itself never escapes. */
  unreachable?: true;
};

/** Network failures as gh and git print them; matched privately, never forwarded. */
const networkFailure =
  /error connecting to|could not resolve host|no such host|dial tcp|connection refused|connection reset|network is unreachable|i\/o timeout|tls handshake timeout|timed out while/i;
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
    if (process.platform === "win32")
      request = { ...request, command: await windowsCommand(request.command, env) };
    request.dispatch?.prepare?.();
    const launch = () =>
      spawn(request.command, [...request.args], {
        cwd: options.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    let child: ReturnType<typeof launch>;
    try {
      child = launch();
    } catch {
      throw new ForgeError("cli", undefined, false);
    }
    let job: WindowsJob | undefined;
    if (process.platform === "win32" && child.pid !== undefined) {
      // gh starts git and credential helpers; a job ends that whole tree with gh.
      job = createKillOnCloseJob();
      job?.assign(child.pid);
    }
    let failure: ForgeError | undefined;
    const stop = () => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") job?.terminate?.();
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
    const tail = new LogTail(request.tailBytes);
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
    let diagnostics = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (diagnostics.length < 4_096) diagnostics += chunk.toString("utf8", 0, 4_096);
    });
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
      return {
        code,
        stdout: output.text,
        truncated: output.truncated,
        ...(code !== 0 && networkFailure.test(diagnostics) ? { unreachable: true as const } : {}),
      };
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
      stop();
      if (process.platform === "win32") job?.dispose();
    }
  };
}

/**
 * Windows: the absolute `.exe` a bare command names on PATH. Node's own search of a bare name
 * tries the working directory (a checkout, maybe someone else's PR) first, and `.cmd` shims
 * can't start without a shell.
 */
async function windowsCommand(command: string, env: NodeJS.ProcessEnv): Promise<string> {
  const searched = Object.fromEntries(
    Object.entries(env).filter(([key]) => key.toUpperCase() !== "PATHEXT"),
  );
  const found = await findExecutable(command, { ...searched, PATHEXT: ".EXE;.COM" }, "win32");
  if (found === undefined) throw new ForgeError("cli", undefined, false);
  return found;
}
