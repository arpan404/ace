import { modelDisplayName } from "@ace/models/display-name";
import type { ProviderKind } from "@ace/protocol";
import { acpAgentBrands, acpRegistryId } from "./acp-agents.ts";

export { acpRegistryId };

/** The provider's product name, as people know it. */
export const providerNames: Record<ProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  antigravity: "Antigravity",
  acp: "ACP agent",
  pi: "Pi",
};

/**
 * The product name for a provider. An ACP agent gets its registry name ("Gemini CLI" for
 * "official:gemini"), or its id without the source prefix when the registry doesn't know it.
 */
export function providerDisplayName(provider: ProviderKind, acpAgentId?: string): string {
  if (provider !== "acp" || !acpAgentId) return providerNames[provider];
  return (
    acpAgentBrands[acpRegistryId(acpAgentId)]?.name ??
    acpAgentId.replace(/^(official|local|registry):/, "")
  );
}

/** "Codex", or "Claude Code · 2 subagents running" while subagents work. */
export function providerLabel(name: string, subagents: number): string {
  return subagents > 0
    ? `${name} · ${subagents} subagent${subagents === 1 ? "" : "s"} running`
    : name;
}

/** A saved model ID uses the catalog's shared human-name formatter. */
export function modelLabel(id: string): string {
  return modelDisplayName(id).displayName;
}
