import type { Brand } from "./brand-art/index.gen.ts";

/*
 * ACP agent names, kept apart from the brand art so plain name lookups never load the marks.
 * `@ace/ui-core/provider-icons` re-exports these with the marks.
 */

/**
 * ACP registry agents by id (https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)
 * with the name the registry gives them. Agents without a brand show the neutral glyph.
 */
export const acpAgentBrands: Record<string, { name: string; brand: Brand | undefined }> = {
  "amp-acp": { name: "Amp", brand: "amp" },
  // ace runs this agent as its built-in Antigravity provider, so it shares that name.
  "antigravity-acp": { name: "Antigravity", brand: "antigravity" },
  auggie: { name: "Auggie CLI", brand: undefined },
  "claude-acp": { name: "Claude Agent", brand: "claude" },
  cline: { name: "Cline", brand: "cline" },
  "codebuddy-code": { name: "Codebuddy Code", brand: "codebuddy" },
  "codex-acp": { name: "Codex", brand: "openai" },
  "cortex-code": { name: "Cortex Code", brand: "snowflake" },
  cursor: { name: "Cursor", brand: "cursor" },
  deepagents: { name: "DeepAgents", brand: "langchain" },
  devin: { name: "Devin", brand: "devin" },
  "factory-droid": { name: "Factory Droid", brand: undefined },
  gemini: { name: "Gemini CLI", brand: "geminicli" },
  "github-copilot-cli": { name: "GitHub Copilot", brand: "githubcopilot" },
  goose: { name: "goose", brand: "goose" },
  "grok-build": { name: "Grok Build", brand: "grok" },
  junie: { name: "Junie", brand: "junie" },
  kilo: { name: "Kilo", brand: "kilocode" },
  kimi: { name: "Kimi CLI", brand: "kimi" },
  "minimax-code": { name: "MiniMax Code", brand: "minimax" },
  "mistral-vibe": { name: "Mistral Vibe", brand: "mistral" },
  opencode: { name: "OpenCode", brand: "opencode" },
  "pi-acp": { name: "Pi", brand: "pi" },
  qoder: { name: "Qoder CLI", brand: "qoder" },
  "qwen-code": { name: "Qwen Code", brand: "qwen" },
};

/** Ids people and older installs use for the same registry agents. */
const acpAliases: Record<string, string> = {
  amp: "amp-acp",
  antigravity: "antigravity-acp",
  claude: "claude-acp",
  "claude-code": "claude-acp",
  "claude-code-acp": "claude-acp",
  codex: "codex-acp",
  copilot: "github-copilot-cli",
  "gemini-cli": "gemini",
  "kilo-code": "kilo",
  pi: "pi-acp",
  qwen: "qwen-code",
};

/** "official:gemini", "local:Gemini CLI" and "gemini-cli" all name the registry's `gemini`. */
export function acpRegistryId(acpAgentId: string): string {
  const id = acpAgentId
    .trim()
    .toLowerCase()
    .replace(/^(official|local|registry):/, "")
    .replace(/\s+/g, "-");
  return acpAliases[id] ?? id;
}
