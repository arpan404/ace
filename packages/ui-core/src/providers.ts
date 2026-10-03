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

const families: Record<string, string> = {
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  gpt: "GPT",
  gemini: "Gemini",
  codex: "Codex",
  mini: "mini",
  pro: "Pro",
  flash: "Flash",
};

/**
 * A model id as people read it, for places that only have the id: "sonnet-4.6" and
 * "claude-sonnet-4-6" read "Sonnet 4.6", "gpt-5.3-codex" reads "GPT-5.3 Codex". Prefer the
 * daemon catalog's display name where one is at hand.
 */
export function modelLabel(id: string): string {
  const parts = id
    .toLowerCase()
    .replace(/^claude-/, "")
    .split("-");
  const words: string[] = [];
  for (const part of parts) {
    const previous = words.at(-1);
    // Version digits split by dashes ("4-6") join with a dot; "gpt" takes its version.
    if (/^\d+(\.\d+)?$/.test(part) && previous !== undefined) {
      if (/\d$/.test(previous)) words[words.length - 1] = `${previous}.${part}`;
      else if (previous === "GPT") words[words.length - 1] = `GPT-${part}`;
      else words.push(part);
    } else words.push(families[part] ?? part);
  }
  return words.join(" ");
}
