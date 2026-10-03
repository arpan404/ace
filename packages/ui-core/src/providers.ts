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

/** "Codex", or "Claude Code · 2 subagents running" while subagents work. */
export function providerLabel(provider: ProviderKind, subagents: number): string {
  const name = providerNames[provider];
  return subagents > 0
    ? `${name} · ${subagents} subagent${subagents === 1 ? "" : "s"} running`
    : name;
}
