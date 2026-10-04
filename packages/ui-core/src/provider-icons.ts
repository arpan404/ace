import type { ProviderKind } from "@ace/protocol";
import type { Brand } from "./brand-art/index.gen.ts";
import { providerDisplayName, providerNames } from "./providers.ts";

/*
 * Which brand mark stands for a provider, an ACP agent or a model family. The marks are LobeHub
 * Icons (MIT, see NOTICE), turned into path data by `scripts/provider-icons.ts`; a provider or
 * agent LobeHub has no mark for gets `brand: undefined` and the renderer draws ace's neutral
 * agent glyph. Never draw a lookalike of someone's logo.
 *
 * Reached only through `@ace/ui-core/provider-icons`, never the package index, so the web app can
 * load these tables lazily and keep them off the first paint.
 */

export type { Brand } from "./brand-art/index.gen.ts";
export { brandArt } from "./brand-art/index.gen.ts";
export type { BrandArt, BrandPath } from "./brand-art-types.ts";

/** The mark each built-in provider shows. ACP agents are looked up by registry id instead. */
export const providerBrands: Record<ProviderKind, Brand | undefined> = {
  claude: "claude",
  codex: "codex",
  opencode: "opencode",
  cursor: "cursor",
  antigravity: "antigravity",
  pi: "pi",
  acp: undefined,
};

/**
 * ACP registry agents by id (https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)
 * with the name the registry gives them. Agents without a brand show the neutral glyph.
 */
export const acpAgentBrands: Record<string, { name: string; brand: Brand | undefined }> = {
  "amp-acp": { name: "Amp", brand: "amp" },
  "antigravity-acp": { name: "Google Antigravity", brand: "antigravity" },
  auggie: { name: "Auggie CLI", brand: undefined },
  "claude-acp": { name: "Claude Agent", brand: "claude" },
  cline: { name: "Cline", brand: "cline" },
  "codebuddy-code": { name: "Codebuddy Code", brand: "codebuddy" },
  "codex-acp": { name: "Codex", brand: "codex" },
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
function registryId(acpAgentId: string): string {
  const id = acpAgentId
    .trim()
    .toLowerCase()
    .replace(/^(official|local|registry):/, "")
    .replace(/\s+/g, "-");
  return acpAliases[id] ?? id;
}

/** The agent's registry name, or its id without the source prefix when the registry is silent. */
export function acpAgentName(acpAgentId: string): string {
  return acpAgentBrands[registryId(acpAgentId)]?.name ?? providerDisplayName("acp", acpAgentId);
}

const modelFamilies: readonly [RegExp, Brand, string][] = [
  [/(?:^|[^a-z])(claude|opus|sonnet|haiku)/, "claude", "Claude"],
  [/(?:^|[^a-z])(chat)?gpt|(?:^|[^a-z0-9])o[1-9](?:$|[^a-z0-9])/, "openai", "OpenAI"],
  [/(?:^|[^a-z])gemini/, "gemini", "Gemini"],
  [/(?:^|[^a-z])gemma/, "gemma", "Gemma"],
  [/(?:^|[^a-z])deepseek/, "deepseek", "DeepSeek"],
  [/(?:^|[^a-z])(qwen|qwq)/, "qwen", "Qwen"],
  [/(?:^|[^a-z])(kimi|moonshot)/, "kimi", "Kimi"],
  [/(?:^|[^a-z])(glm|z-?ai)(?:$|[^a-z])/, "zai", "Z.ai GLM"],
  [/(?:^|[^a-z])minimax/, "minimax", "MiniMax"],
  [/(?:^|[^a-z])(mistral|devstral|codestral|magistral|ministral)/, "mistral", "Mistral"],
  [/(?:^|[^a-z])grok/, "grok", "Grok"],
  [/(?:^|[^a-z])llama/, "meta", "Llama"],
  [/(?:^|[^a-z])composer(?:$|[^a-z])/, "cursor", "Cursor Composer"],
];

/** The family a model id or display name belongs to ("claude-sonnet-4-6" → Claude), if known. */
export function modelFamily(model: string): { brand: Brand; label: string } | undefined {
  const id = model.toLowerCase();
  for (const [pattern, brand, label] of modelFamilies)
    if (pattern.test(id)) return { brand, label };
  return undefined;
}

export interface ProviderIconInput {
  provider: ProviderKind;
  /** For `provider: "acp"`: the registry id that picks the agent's own mark. */
  acpAgentId?: string | undefined;
  /** A model id or name; its family's mark wins over the provider's when one is known. */
  model?: string | undefined;
}

/** The mark to draw and the words that name it for assistive tech. */
export interface ProviderIconChoice {
  brand: Brand | undefined;
  label: string;
}

/** Picks the mark for a provider, ACP agent or model. Unknown agents get the neutral glyph. */
export function providerIcon(input: ProviderIconInput): ProviderIconChoice {
  const family = input.model ? modelFamily(input.model) : undefined;
  if (family) return family;
  if (input.provider === "acp") {
    if (!input.acpAgentId) return { brand: undefined, label: providerNames.acp };
    return {
      brand: acpAgentBrands[registryId(input.acpAgentId)]?.brand,
      label: acpAgentName(input.acpAgentId),
    };
  }
  return { brand: providerBrands[input.provider], label: providerNames[input.provider] };
}

/**
 * Marks whose detail (a cutout, a glyph inside a shape) blurs into a blob at row sizes (under
 * 16px), and the simpler mark of the same maker drawn there instead: Codex's cloud with its
 * prompt becomes the OpenAI blossom.
 */
const smallBrands: Partial<Record<Brand, Brand>> = { codex: "openai" };

/** The brand to draw at `size` pixels: the mark itself, or its simpler stand-in when tiny. */
export function brandAtSize(brand: Brand, size: number): Brand {
  return size < 16 ? (smallBrands[brand] ?? brand) : brand;
}
