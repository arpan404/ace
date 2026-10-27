import { McpServerInput, type McpSources, type ProviderKind } from "@ace/protocol";
import { splitCommand } from "./acp-manual-agent.ts";

/*
 * A provider's own MCP servers as Settings shows them: one plain word per state, and the Add
 * MCP server form's checks. A server waiting for its own sign-in is the server's business,
 * never a problem with the provider. ace adds no approval of its own: the provider's
 * configuration and permissions decide. Pure.
 */

/** The providers whose sessions hand ace their MCP controls. */
export function providerHasMcpServers(provider: ProviderKind): boolean {
  return provider === "claude" || provider === "codex" || provider === "opencode";
}

export type McpServerStatus = McpSources["servers"][number]["status"];

const words: Record<McpServerStatus, string | undefined> = {
  connected: "Connected",
  connecting: "Starting…",
  disabled: "Off",
  needs_auth: "Not signed in",
  failed: "Couldn't start",
  unknown: undefined,
};

/** The status word for a server; nothing when the provider doesn't say. */
export function mcpServerWord(status: McpServerStatus): string | undefined {
  return words[status];
}

/** The note under a provider's servers: why the list is empty, or when changes apply. */
export function mcpServersNote(sources: McpSources, providerName: string): string | undefined {
  if (!sources.live)
    return `${providerName}'s MCP servers show here while one of its threads is running.`;
  return sources.appliesNextTurn ? "Changes apply on the next turn." : undefined;
}

export interface McpServerDraft {
  name: string;
  transport: "command" | "http";
  /** The command line (program and arguments) or the server URL. */
  address: string;
}

export type McpServerCheck =
  | { ok: true; name: string; server: McpServerInput; display: string }
  | { ok: false; field: "name" | "address"; problem: string };

/** The server to add, or what to fix first. Names already in the list are refused here. */
export function checkMcpServer(
  draft: McpServerDraft,
  taken: readonly string[] = [],
): McpServerCheck {
  const name = draft.name.trim();
  if (!name) return { ok: false, field: "name", problem: "Give the server a name." };
  if (name === "ace") return { ok: false, field: "name", problem: "ace is a reserved name." };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name))
    return {
      ok: false,
      field: "name",
      problem: "Use letters, numbers, - and _ in the name, up to 64.",
    };
  if (taken.includes(name))
    return { ok: false, field: "name", problem: `A server named ${name} is already there.` };
  const address = draft.address.trim();
  if (draft.transport === "http") {
    if (!address) return { ok: false, field: "address", problem: "Enter the server URL." };
    const parsed = McpServerInput.safeParse({ transport: "http", url: address });
    if (!parsed.success)
      return {
        ok: false,
        field: "address",
        problem: "Use an http or https URL without a password, query or #part.",
      };
    return { ok: true, name, server: parsed.data, display: address };
  }
  if (!address)
    return { ok: false, field: "address", problem: "Enter the command that starts the server." };
  const words = splitCommand(address);
  if (!words) return { ok: false, field: "address", problem: "Close the quote in the command." };
  const [command, ...args] = words;
  const parsed = McpServerInput.safeParse({ transport: "command", command, args });
  if (!command || !parsed.success)
    return { ok: false, field: "address", problem: "Use a shorter command." };
  return { ok: true, name, server: parsed.data, display: address };
}
