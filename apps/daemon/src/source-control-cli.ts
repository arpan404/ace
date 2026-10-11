import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverProvider, type DiscoveryOptions } from "@ace/provider-kit/discovery";
import {
  spawnRawSupervised,
  type SpawnOptions,
  type RawSupervisedProcess,
} from "@ace/provider-kit/process";
import { SourceControlDraftInput, type SourceControlContext } from "@ace/protocol";
import { systemClock, type EngineClock } from "./engine/actor.ts";
import { writingPrompt, parseWritingOutput } from "./source-control-prompt.ts";

export interface WritingCliOptions {
  discover?: typeof discoverProvider;
  spawn?: (options: SpawnOptions) => RawSupervisedProcess;
  clock?: EngineClock;
  tempRoot?: string;
  env?: NodeJS.ProcessEnv;
  configuration?(provider: "claude" | "codex"):
    | {
        enabled?: boolean | undefined;
        binaryPath?: string | undefined;
        defaultModel?: string | null | undefined;
      }
    | undefined;
}
/** A single restricted CLI invocation, outside the checkout. It owns no engine agent or continuation. */
export function createWritingCli(options: WritingCliOptions = {}) {
  const discover = options.discover ?? discoverProvider;
  const spawn = options.spawn ?? spawnRawSupervised;
  const clock = options.clock ?? systemClock;
  return async (
    unparsed: SourceControlDraftInput,
    context: SourceControlContext,
    threadContext: string,
    signal: AbortSignal,
  ) => {
    const input = SourceControlDraftInput.parse(unparsed);
    signal.throwIfAborted();
    const configuration = options.configuration?.(input.provider);
    if (configuration?.enabled === false) throw new Error("draft_provider_unavailable");
    const discoveryOptions: DiscoveryOptions = {
      signal,
      ...(options.env ? { env: options.env } : {}),
      ...(configuration?.binaryPath
        ? { overrides: { [input.provider]: configuration.binaryPath } }
        : {}),
    };
    const cli = await discover(input.provider, discoveryOptions);
    if (!cli.installed || !cli.path || cli.auth === "logged_out")
      throw new Error("draft_provider_unavailable");
    signal.throwIfAborted();
    const directory = await mkdtemp(join(options.tempRoot ?? tmpdir(), "ace-writing-"));
    let child: RawSupervisedProcess | undefined;
    let cancelTimer: (() => void) | undefined;
    const stop = () => {
      void child?.stop({ graceMs: 0 });
    };
    let timedOut = false;
    try {
      signal.throwIfAborted();
      const model = input.model ?? configuration?.defaultModel;
      const args =
        input.provider === "claude"
          ? [
              "--print",
              "--safe-mode",
              "--tools",
              "",
              "--disallowedTools",
              "mcp__*",
              "--strict-mcp-config",
              "--mcp-config",
              '{"mcpServers":{}}',
              "--disable-slash-commands",
              "--no-session-persistence",
              "--output-format",
              "json",
              "--max-turns",
              "1",
            ]
          : [
              "exec",
              "--ephemeral",
              "--ignore-user-config",
              "--skip-git-repo-check",
              "--sandbox",
              "read-only",
              "-c",
              'approval_policy="never"',
              "--json",
              "-c",
              "mcp_servers={}",
              "-c",
              "features.shell_tool=false",
              "-c",
              "features.unified_exec=false",
              "-c",
              "features.apply_patch_freeform=false",
              "-c",
              "features.multi_agent=false",
              "-c",
              "features.apps=false",
              "-c",
              'web_search="disabled"',
            ];
      if (model && model !== "default") args.push("--model", model);
      if (input.provider === "codex") args.push("-");
      child = spawn({
        command: cli.path,
        args,
        cwd: directory,
        env: options.env ?? {},
        name: "source-control-writing",
        maxOutputBytes: 1_048_576,
      });
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      cancelTimer = clock.setTimer(() => {
        timedOut = true;
        stop();
      }, 120_000);
      const chunks: Buffer[] = [];
      child.stdout.on("data", (bytes: Buffer) => chunks.push(bytes));
      // Diagnostic bytes are bounded by supervision and discarded, never sent to clients.
      child.stderr.resume();
      child.stdin.end(writingPrompt(input, context, threadContext));
      const exit = await child.exited;
      signal.throwIfAborted();
      if (timedOut) throw new Error("draft_timeout");
      if (exit.code !== 0 || exit.reason !== "exit") throw new Error("draft_provider_failed");
      const output = Buffer.concat(chunks).toString("utf8");
      return parseWritingOutput(input.provider, output);
    } catch (error) {
      if (signal.aborted) {
        // oxlint-disable-next-line eslint/preserve-caught-error -- External diagnostics may contain credentials.
        throw new Error("draft_cancelled");
      }
      if (error instanceof Error && error.message.startsWith("draft_")) throw error;
      // oxlint-disable-next-line eslint/preserve-caught-error -- External diagnostics may contain credentials.
      throw new Error("draft_invalid_output");
    } finally {
      cancelTimer?.();
      signal.removeEventListener("abort", stop);
      await child?.stop({ graceMs: 0 });
      await rm(directory, { recursive: true, force: true });
    }
  };
}
