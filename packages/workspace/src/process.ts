import { spawn } from "node:child_process";
import { aborted, errorCode, WorkspaceError } from "./types.ts";

/** Own the process, drain both streams, and always reap it before returning. */
export async function command(
  binary: string,
  args: string[],
  options: {
    cwd?: string;
    input?: Buffer;
    signal?: AbortSignal;
    outputCap?: number;
    onLine?: (line: string) => boolean;
  } = {},
): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  aborted(options.signal);
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: { ...process.env, RIPGREP_CONFIG_PATH: "", GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let pending = "";
    let stopped = false;
    let problem: unknown;
    const decoder = new TextDecoder();
    const stop = () => {
      stopped = true;
      child.kill("SIGKILL");
    };
    const cancel = () => {
      problem = new WorkspaceError("ABORTED", "Search cancelled");
      stop();
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    child.on("error", (error) => {
      problem = error;
    });
    child.stdin.on("error", (error) => {
      if (!stopped && errorCode(error) !== "EPIPE") {
        problem = error;
        stop();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(0, 8192);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (stopped) return;
      bytes += chunk.length;
      if (bytes > (options.outputCap ?? 4 * 1024 * 1024)) {
        problem = new WorkspaceError("LIMIT_EXCEEDED", "Command output exceeded its byte budget");
        stop();
        return;
      }
      if (!options.onLine) {
        chunks.push(chunk);
        return;
      }
      pending += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try {
          if (!options.onLine(line)) {
            stop();
            break;
          }
        } catch (error) {
          problem = error;
          stop();
          break;
        }
      }
    });
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", cancel);
      if (problem) {
        reject(problem);
        return;
      }
      try {
        pending += decoder.decode();
        if (!stopped && pending && options.onLine) options.onLine(pending);
        resolve({ code: stopped ? 0 : code, stdout: Buffer.concat(chunks), stderr });
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(options.input);
  });
}
