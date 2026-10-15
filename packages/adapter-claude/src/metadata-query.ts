import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { SpawnOptions, SupervisedProcess } from "@ace/provider-kit/process";
import { InputStream } from "./input.ts";
import { spawnSdkProcess } from "./sdk-process.ts";
import { configurationOptions, isolatedConfiguration } from "./configuration.ts";

function noop(): void {}

/** The discovered CLI, the account's home in its environment, and cancellation. */
export interface MetadataQueryInput {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  spawn?: (options: SpawnOptions) => SupervisedProcess;
}

/**
 * One question to an initialization-only query, then the CLI stops: no prompt is ever sent, so no
 * model turn runs, and no user or project settings load (no hooks, no MCP servers). `what` names
 * the question in the fixed words of its errors.
 */
export async function askClaude<T>(
  input: MetadataQueryInput,
  what: string,
  ask: (query: Query) => Promise<T>,
): Promise<T> {
  input.signal.throwIfAborted();
  const prompt = new InputStream();
  const controller = new AbortController();
  let process: SupervisedProcess | undefined;
  const stop = () => {
    controller.abort();
    if (process) void process.stop({ graceMs: 0 });
  };
  input.signal.addEventListener("abort", stop, { once: true });
  let q: Query | undefined;
  let answer: T;
  let outputLimited = false;
  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    input.signal.throwIfAborted();
    q = query({
      prompt,
      options: {
        cwd: input.cwd,
        env: input.env,
        pathToClaudeCodeExecutable: input.executable,
        abortController: controller,
        ...configurationOptions(isolatedConfiguration),
        mcpServers: {},
        spawnClaudeCodeProcess: (options) =>
          spawnSdkProcess(
            { ...options, command: input.executable, args: [...input.args, ...options.args] },
            {
              ...(input.spawn ? { spawn: input.spawn } : {}),
              maxOutputBytes: 4 * 1024 * 1024,
              onWire() {},
              onStderr() {},
              onProcess(handle) {
                process = handle;
              },
            },
          ),
      },
    });
    const current = q;
    let removeAbort: () => void = noop;
    const cancelled = new Promise<never>((_, reject) => {
      const abort = () => reject(new Error(`Claude ${what} aborted`));
      controller.signal.addEventListener("abort", abort, { once: true });
      removeAbort = () => controller.signal.removeEventListener("abort", abort);
      if (controller.signal.aborted) abort();
    });
    try {
      answer = await Promise.race([ask(current), cancelled]);
    } finally {
      removeAbort();
    }
  } finally {
    input.signal.removeEventListener("abort", stop);
    prompt.close();
    q?.close();
    controller.abort();
    if (process) {
      const exit = await process.stop({ graceMs: 0 });
      outputLimited = exit.reason === "output-limit";
    }
  }
  if (outputLimited) throw new Error(`Claude ${what} output exceeded limit`);
  input.signal.throwIfAborted();
  return answer;
}
