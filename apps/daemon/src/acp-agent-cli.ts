import { z } from "zod";
import { probeOutput } from "@ace/provider-kit/process";

/*
 * What some ACP agents' own command does that their ACP leaves out. Cursor's `cursor-agent`
 * serves ACP with `acp`, and signs out and reports its login with its own subcommands, while its
 * ACP advertises neither (cursor-agent 2026.10.01). Keyed by registry agent id; the installed
 * command is the one the registry approved for the agent.
 */

export interface AcpAgentCli {
  /** Arguments that sign the agent's own login out. */
  logout: readonly string[];
  /** Arguments that report the login without changing it. */
  status: readonly string[];
  /** Whether the status output says the agent is signed in; undefined when it can't tell. */
  signedIn(stdout: string): boolean | undefined;
}

const CursorStatus = z.object({ isAuthenticated: z.boolean() }).passthrough();

const agents: Record<string, AcpAgentCli> = {
  "official:cursor": {
    logout: ["logout"],
    status: ["status", "--format", "json"],
    signedIn(stdout) {
      try {
        const parsed = CursorStatus.safeParse(JSON.parse(stdout));
        return parsed.success ? parsed.data.isAuthenticated : undefined;
      } catch {
        return undefined;
      }
    },
  },
};

export function acpAgentCli(acpAgentId: string | undefined): AcpAgentCli | undefined {
  return acpAgentId ? agents[acpAgentId] : undefined;
}

/**
 * Whether the person's `cursor-agent` is signed in, by its own status report. Its login is
 * separate from the Cursor SDK's, so a CLI-run task asks it directly. Undefined when it can't
 * tell (an older CLI, a timeout): the caller decides.
 */
export async function cursorAgentSignedIn(
  command: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  probe: typeof probeOutput = probeOutput,
): Promise<boolean | undefined> {
  const cursor = agents["official:cursor"];
  if (!cursor) return undefined;
  try {
    const result = await probe(command, cursor.status, { env, signal, timeoutMs: 5_000 });
    return result.code === 0 ? cursor.signedIn(result.stdout) : undefined;
  } catch {
    signal.throwIfAborted();
    return undefined;
  }
}
