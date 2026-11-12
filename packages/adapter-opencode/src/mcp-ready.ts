import { fileURLToPath } from "node:url";
import { parse, type ParseError } from "jsonc-parser";
import { z } from "zod";
import type { OpenCodeClient } from "@opencode/client";
import type { Runtime } from "./runtime.ts";
import { aceReadinessTool, mcpReadyRpc } from "./mcp-ready-contract.ts";

const ConfigPlugins = z.array(z.unknown()).max(64);
const ConfigSkills = z.array(z.string()).max(64);
const ReadyCatalog = z.object({
  tools: z.array(z.object({ name: z.string(), description: z.string() })).max(256),
});

export function mcpReadyPluginDirectory(): string {
  return fileURLToPath(new URL("./mcp-ready-plugin", import.meta.url));
}

/**
 * Add ace's credential-free extras to OpenCode's runtime config: the readiness plugin for owned
 * MCP sessions and ace's shipped skill directories. OpenCode adds `skills` paths from this
 * layer to the person's own (checked against OpenCode 2.0.29's skill API), and user config and
 * persistent files stay provider-owned.
 */
export function aceConfigEnvironment(
  env: NodeJS.ProcessEnv | undefined,
  content: string,
  extras: { plugin?: string | undefined; skills?: readonly string[] | undefined },
): NodeJS.ProcessEnv {
  if (Buffer.byteLength(content) > 256 * 1024)
    throw new Error("OpenCode configuration exceeds limit");
  const errors: ParseError[] = [];
  const config = z
    .record(z.string(), z.unknown())
    .parse(parse(content, errors, { allowTrailingComma: true }));
  if (errors.length) throw new Error("Invalid OpenCode configuration");
  const plugins = ConfigPlugins.parse(config["plugins"] ?? []);
  const skills = ConfigSkills.parse(config["skills"] ?? []);
  return {
    ...env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...config,
      ...(extras.plugin ? { plugins: [...plugins, extras.plugin] } : {}),
      ...(extras.skills?.length ? { skills: [...skills, ...extras.skills] } : {}),
    }),
  };
}

/** OpenCode answers a call to an RPC no plugin has registered (yet) with this error. */
const RpcUnavailable = z.object({ type: z.literal("rpc.unavailable") });

/** How long readiness may take overall, including the wait for ace's native tools. */
export const aceToolsReadyBudgetMs = 10_000;

export type ReadinessStep = { retryInMs: number } | "unconfirmed" | "fail";

/**
 * What to do after a readiness call failed. OpenCode 2.2.7 activates plugins after its
 * instance already answers requests, so the readiness RPC is briefly unavailable on a fresh
 * location; earlier releases registered it first. An unavailable RPC is retried while
 * `patienceMs` lasts, then reported as unconfirmed: ace's tools may or may not have loaded,
 * and only the plugin can tell. Any other failure is real.
 */
export function readinessStep(
  error: unknown,
  elapsedMs: number,
  patienceMs: number,
): ReadinessStep {
  if (!RpcUnavailable.safeParse(error).success) return "fail";
  const retryInMs = Math.min(500, 100 * 2 ** Math.floor(elapsedMs / 400));
  return elapsedMs + retryInMs <= patienceMs ? { retryInMs } : "unconfirmed";
}

/**
 * Waits until OpenCode lists ace's `context` tool natively. Resolves "ready" once the
 * readiness plugin confirms it, or "unconfirmed" when the plugin's RPC never became available
 * within `patienceMs`; throws when the plugin reports the tools missing or the budget runs out.
 */
export async function waitForAceTools(
  client: OpenCodeClient,
  directory: string,
  runtime: Runtime,
  patienceMs = aceToolsReadyBudgetMs,
): Promise<"ready" | "unconfirmed"> {
  const controller = new AbortController();
  const cancel = runtime.schedule(() => controller.abort(), aceToolsReadyBudgetMs);
  const started = runtime.monotonic();
  try {
    for (;;) {
      let reply: unknown;
      try {
        reply = await client
          .rpc(mcpReadyRpc)
          .ready({}, { location: { directory }, signal: controller.signal });
      } catch (error) {
        const step = readinessStep(error, runtime.monotonic() - started, patienceMs);
        if (step === "fail") throw error;
        // Running out of budget while the RPC is still unregistered is the same answer.
        if (step === "unconfirmed" || !(await pause(runtime, step.retryInMs, controller.signal)))
          return "unconfirmed";
        continue;
      }
      const catalog = ReadyCatalog.parse(reply);
      if (!catalog.tools.some((tool) => tool.name === aceReadinessTool && tool.description))
        throw new Error("OpenCode ace context tool is missing from its native catalog");
      return "ready";
    }
  } finally {
    cancel();
  }
}

/** Resolves true after `delayMs`, or false as soon as `signal` aborts. */
function pause(runtime: Runtime, delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const abort = () => {
      cancel();
      resolve(false);
    };
    const cancel = runtime.schedule(() => {
      signal.removeEventListener("abort", abort);
      resolve(true);
    }, delayMs);
    signal.addEventListener("abort", abort, { once: true });
  });
}
