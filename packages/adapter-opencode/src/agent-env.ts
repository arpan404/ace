import { fileURLToPath } from "node:url";
import type { OpenCodeClient } from "@opencode/client";
import { agentEnvRpc } from "./agent-env-contract.ts";
import { aceToolsReadyBudgetMs, pause, readinessStep } from "./mcp-ready.ts";
import type { Runtime } from "./runtime.ts";

/**
 * Each OpenCode session's own shell variables (ADR 0176 §10).
 *
 * An OpenCode server serves many sessions, and ace starts it before any thread exists, so its
 * process environment can't name a thread. OpenCode's `PUT /api/session/:id/environment` sets
 * the environment its local shell commands run with for one session (checked against
 * `@opencode/client` 2.0.22 and OpenCode 2.3.0): it replaces the server's process environment
 * for that session only, lives in the server's memory until the session is removed or the
 * server exits, and is not inherited by subagent sessions. So ace sends the whole environment
 * the server's own shells would have had, without any credential, plus the thread's variables,
 * for the root session at every open and for every subagent session as ace admits it.
 *
 * A subagent session exists, and is prompted, before ace hears of it. So that none of its
 * commands runs with the server's own environment, ace's gate plugin (`agent-env-plugin`)
 * holds every tool of every session until ace settles that session: set, or failed, which
 * refuses the tool. And the server never holds a credential an agent's shell could inherit:
 * ace starts it without its own secrets, and OpenCode's `serve --stdio` drops its password
 * from its own environment once read (2.3.0).
 */

/** Credentials no agent's shell ever needs: OpenCode's server's own, and ace's. */
const withheld = new Set([
  "OPENCODE_PASSWORD",
  "OPENCODE_SERVER_PASSWORD",
  "ACE_MCP_BEARER_TOKEN",
  "ACE_MCP_TOKEN",
  "ACE_DAEMON_TOKEN",
  "ACE_DAEMON_TOKEN_FILE",
  "ACE_MARKET_SIGNER_TOKEN",
  "ACE_GRANT_KEY",
  "ACE_GRANT_PREVIOUS_KEY",
  "ACE_ACCOUNT_ENCRYPTION_KEY",
]);

/** ace's own credentials removed, as a spawn's environment merged over ace's own. */
export function withoutAceSecrets(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const removed: NodeJS.ProcessEnv = {};
  for (const name of withheld) if (name.startsWith("ACE_")) removed[name] = undefined;
  return { ...env, ...removed };
}

/**
 * What one session's shell commands run with: what the server process inherited, without any
 * credential, then the thread's variables, which win over a same-named inherited one. Pure.
 */
export function sessionShellEnvironment(
  inherited: NodeJS.ProcessEnv,
  agentEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const [name, value] of Object.entries(inherited))
    if (value !== undefined && !withheld.has(name)) variables[name] = value;
  return { ...variables, ...agentEnv };
}

export function agentEnvPluginDirectory(): string {
  return fileURLToPath(new URL("./agent-env-plugin", import.meta.url));
}

/**
 * Tells the gate whether `sessionID`'s environment is set, so its tools run or are refused.
 * OpenCode activates plugins per location, a moment after the location first answers, so an
 * unregistered RPC is retried for a while; anything else, or running out of time, throws.
 */
export async function settleEnvironment(
  client: OpenCodeClient,
  runtime: Runtime,
  directory: string,
  verdict: { sessionID: string; ok: boolean; message?: string },
): Promise<void> {
  const controller = new AbortController();
  const cancel = runtime.schedule(() => controller.abort(), aceToolsReadyBudgetMs);
  const started = runtime.monotonic();
  try {
    for (;;) {
      try {
        await client
          .rpc(agentEnvRpc)
          .settle(verdict, { location: { directory }, signal: controller.signal });
        return;
      } catch (error) {
        const step = readinessStep(error, runtime.monotonic() - started, aceToolsReadyBudgetMs);
        if (step === "fail") throw error;
        if (step === "unconfirmed" || !(await pause(runtime, step.retryInMs, controller.signal)))
          throw new Error("OpenCode never registered ace's environment gate", { cause: error });
      }
    }
  } finally {
    cancel();
  }
}
