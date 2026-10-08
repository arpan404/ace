import { modelDisplayName } from "@ace/models/display-name";
import type { ProviderKind } from "@ace/protocol";

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
 * The product name for a provider; an ACP agent's id without its source prefix ("gemini" for
 * "official:gemini"). `acpAgentName` in `@ace/ui-core/provider-icons` knows registry names.
 */
export function providerDisplayName(provider: ProviderKind, acpAgentId?: string): string {
  return provider === "acp" && acpAgentId
    ? acpAgentId.replace(/^(official|local|registry):/, "")
    : providerNames[provider];
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
