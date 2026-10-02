import { inputPipe, type InputPipe } from "./input-pipe.ts";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { workspaceRuntime, type WorkspaceRuntime } from "./runtime.ts";
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
    onChunk?: (chunk: string) => boolean;
    inputs?: AsyncIterable<Buffer>[];
  } = {},
  runtime: WorkspaceRuntime = workspaceRuntime(),
): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  aborted(options.signal);
  return new Promise((resolve, reject) => {
    const pipes: InputPipe[] = [];
    let child;
    try {
      for (let index = 0; index < (options.inputs?.length ?? 0); index++) pipes.push(inputPipe());
      child = runtime.spawn(binary, args, {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: { ...process.env, RIPGREP_CONFIG_PATH: "", GIT_OPTIONAL_LOCKS: "0" },
        stdio: ["pipe", "pipe", "pipe", ...pipes.map((pipe) => pipe.fd)],
      });
      for (const pipe of pipes) pipe.releaseReader();
    } catch (error) {
      void Promise.all(pipes.map((pipe) => pipe.dispose())).then(() => reject(error));
      return;
    }
    const { stdin, stdout, stderr: errors } = child;
    if (!stdin || !stdout || !errors) {
      child.kill("SIGKILL");
      void Promise.all(pipes.map((pipe) => pipe.dispose())).then(() =>
        reject(new Error("Search process requires piped streams")),
      );
      return;
    }
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
    stdin.on("error", (error) => {
      if (!stopped && errorCode(error) !== "EPIPE") {
        problem = error;
        stop();
      }
    });
    errors.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(0, 8192);
    });
    stdout.on("data", (chunk: Buffer) => {
      if (stopped) return;
      bytes += chunk.length;
      if (bytes > (options.outputCap ?? 4 * 1024 * 1024)) {
        problem = new WorkspaceError("LIMIT_EXCEEDED", "Command output exceeded its byte budget");
        stop();
        return;
      }
      if (options.onChunk) {
        try {
          if (!options.onChunk(decoder.decode(chunk, { stream: true }))) stop();
        } catch (error) {
          problem = error;
          stop();
        }
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
    child.on("close", async (code) => {
      await Promise.all(writers);
      await Promise.all(pipes.map((pipe) => pipe.dispose()));
      options.signal?.removeEventListener("abort", cancel);
      if (problem) {
        reject(problem);
        return;
      }
      try {
        pending += decoder.decode();
        if (!stopped && options.onChunk) options.onChunk(pending);
        if (!stopped && pending && options.onLine) options.onLine(pending);
        resolve({ code: stopped ? 0 : code, stdout: Buffer.concat(chunks), stderr });
      } catch (error) {
        reject(error);
      }
    });
    const writers = (options.inputs ?? []).map((input, index) => {
      const pipe = pipes[index];
      if (!pipe) {
        problem = new Error("Missing search input pipe");
        stop();
        return Promise.resolve();
      }
      return pipeline(Readable.from(input), pipe.stream).catch((error: unknown) => {
        if (!stopped && errorCode(error) !== "EPIPE") {
          problem = error;
          stop();
        }
      });
    });
    stdin.end(options.input);
  });
}
