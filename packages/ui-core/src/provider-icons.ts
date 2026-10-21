import type { ProviderKind } from "@ace/protocol";
import type { Brand } from "./brand-art/index.gen.ts";
import { acpAgentBrands, acpRegistryId } from "./acp-agents.ts";
import { providerDisplayName, providerNames } from "./providers.ts";

export { acpAgentBrands, acpRegistryId } from "./acp-agents.ts";

/*
 * Which brand mark stands for a provider, an ACP agent or a model family. The marks are LobeHub
 * Icons (MIT, see NOTICE), and the OpenAI Blossom from OpenAI's own brand kit, turned into path
 * data by `scripts/provider-icons.ts`; a provider or agent with no mark gets `brand: undefined`
 * and the renderer draws ace's neutral agent glyph. Never draw a lookalike of someone's logo.
 *
 * Reached only through `@ace/ui-core/provider-icons`, never the package index, so the web app can
 * load these tables lazily and keep them off the first paint.
 */

export type { Brand } from "./brand-art/index.gen.ts";
export { brandArt } from "./brand-art/index.gen.ts";
export type { BrandArt, BrandGradient, BrandPath } from "./brand-art-types.ts";

/** The mark each built-in provider shows. ACP agents are looked up by registry id instead. */
export const providerBrands: Record<ProviderKind, Brand | undefined> = {
  claude: "claude",
  // Codex is OpenAI's, now under the ChatGPT name: it carries the OpenAI Blossom.
  codex: "openai",
  opencode: "opencode",
  cursor: "cursor",
  antigravity: "antigravity",
  pi: "pi",
  acp: undefined,
};

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
  /** A particular mark that wins over both (a service OpenCode reaches: `serviceInfo`). */
  brand?: Brand | undefined;
}

/** The mark to draw and the words that name it for assistive tech. */
export interface ProviderIconChoice {
  brand: Brand | undefined;
  label: string;
}

/** Picks the mark for a provider, ACP agent or model. Unknown agents get the neutral glyph. */
export function providerIcon(input: ProviderIconInput): ProviderIconChoice {
  if (input.brand) return { brand: input.brand, label: input.brand };
  const family = input.model ? modelFamily(input.model) : undefined;
  if (family) return family;
  if (input.provider === "acp") {
    if (!input.acpAgentId) return { brand: undefined, label: providerNames.acp };
    return {
      brand: acpAgentBrands[acpRegistryId(input.acpAgentId)]?.brand,
      label: providerDisplayName("acp", input.acpAgentId),
    };
  }
  return { brand: providerBrands[input.provider], label: providerNames[input.provider] };
}
