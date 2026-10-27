import { z } from "zod";
import { MachineName, type McpAttribution } from "@ace/protocol";
import type { Toolkit } from "@ace/mcp-server";
import {
  CommandJobArgs,
  CommandOutputArgs,
  CommandRunArgs,
  defaultTimeoutSeconds,
  maxForegroundSeconds,
} from "./command-rules.ts";

/** Sends one command tool to another machine (`MachineCaller.command`). */
export type CommandRoute = (
  caller: McpAttribution,
  call: { machine: string; tool: string; args: Record<string, unknown>; timeoutMs: number },
  signal: AbortSignal,
) => Promise<unknown>;

const machine = MachineName.describe(
  "A machine from machines whose tools include commands. Run commands on this machine with your own shell.",
);
const tools = [
  {
    name: "command_run",
    title: "Run a command on another machine",
    description:
      "Run a shell command in a project on another paired machine (machines lists which accept commands) and get its exit code with the last 64 KB of stdout and stderr. For dev servers and long builds pass background: true. That machine logs every command.",
    input: CommandRunArgs.extend({ machine }),
    timeoutMs: (maxForegroundSeconds + 30) * 1000,
  },
  {
    name: "command_status",
    title: "Check a command job on another machine",
    description:
      "Whether a background command from command_run is still running, its exit code and how much it wrote.",
    input: CommandJobArgs.extend({ machine }),
    timeoutMs: 30_000,
  },
  {
    name: "command_output",
    title: "Read a command job's output",
    description:
      "A page of a background command's stdout or stderr (up to 64 KB). It keeps the last 1 MB of each; pass offset to page.",
    input: CommandOutputArgs.extend({ machine }),
    timeoutMs: 30_000,
  },
  {
    name: "command_stop",
    title: "Stop a command job",
    description: "Stop a background command and every process it started.",
    input: CommandJobArgs.extend({ machine }),
    timeoutMs: 30_000,
  },
] as const;

/** How long the call to the machine may take: a foreground run's own timeout, plus slack. */
function callTimeoutMs(tool: string, args: Record<string, unknown>): number {
  if (tool !== "command_run" || args["background"] === true) return 25_000;
  const seconds = typeof args["timeoutSeconds"] === "number" ? args["timeoutSeconds"] : undefined;
  return Math.min(seconds ?? defaultTimeoutSeconds, maxForegroundSeconds) * 1000 + 15_000;
}

/**
 * Commands on other paired machines (ADR 0105). They exist only for other machines, so `machine`
 * is required; a local agent runs commands with its provider's own shell.
 */
export function commandToolkit(route: CommandRoute): Toolkit {
  return {
    register(registry) {
      for (const tool of tools)
        registry.registerContent({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          riskClass: "external-effect",
          openWorld: true,
          toolset: "ace-agents",
          capability: "agents",
          input: tool.input,
          timeoutMs: tool.timeoutMs,
          async run(raw, { caller, signal }) {
            const { machine: name, ...args } = z.record(z.string(), z.unknown()).parse(raw);
            return route(
              caller,
              {
                machine: MachineName.parse(name),
                tool: tool.name,
                args,
                timeoutMs: callTimeoutMs(tool.name, args),
              },
              signal,
            );
          },
        });
    },
  };
}
