import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { SpawnOptions, SupervisedProcess } from "@ace/provider-kit/process";
import { InputStream } from "./input.ts";
import { spawnSdkProcess } from "./sdk-process.ts";
import { configurationOptions, isolatedConfiguration } from "./configuration.ts";

function noop(): void {}

/** Initialization-only query. The host supplies the discovered CLI, its home and cancellation. */
export async function discoverClaudeModels(input: {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  spawn?: (options: SpawnOptions) => SupervisedProcess;
}): Promise<unknown> {
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
  let models: unknown;
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
      const abort = () => reject(new Error("Claude model discovery aborted"));
      controller.signal.addEventListener("abort", abort, { once: true });
      removeAbort = () => controller.signal.removeEventListener("abort", abort);
      if (controller.signal.aborted) abort();
    });
    try {
      models = await Promise.race([current.supportedModels(), cancelled]);
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
  if (outputLimited) throw new Error("Claude model metadata output exceeded limit");
  input.signal.throwIfAborted();
  return { models };
}
