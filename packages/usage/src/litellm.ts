import { z } from "zod";
import type { PriceTable } from "./settings.ts";

export const priceUrl =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const tokenRate = z.number().finite().nonnegative().max(1);
const Entry = z
  .object({
    input_cost_per_token: tokenRate,
    output_cost_per_token: tokenRate,
    cache_read_input_token_cost: tokenRate.optional(),
    cache_creation_input_token_cost: tokenRate.optional(),
    cache_creation_input_token_cost_above_1hr: tokenRate.optional(),
    output_cost_per_reasoning_token: tokenRate.optional(),
  })
  .passthrough();

/** Unknown entries are ignored individually; a non-price document is rejected. */
export function parseLiteLLM(input: unknown, date: string): PriceTable {
  const entries = z.record(z.string(), z.unknown()).parse(input);
  const models: PriceTable["models"] = {};
  for (const [key, value] of Object.entries(entries)) {
    if (key === "sample_spec") continue;
    const parsed = Entry.safeParse(value);
    if (!parsed.success) continue;
    const p = parsed.data;
    models[key] = {
      input: p.input_cost_per_token * 1e6,
      output: p.output_cost_per_token * 1e6,
      cached: (p.cache_read_input_token_cost ?? p.input_cost_per_token) * 1e6,
      write: (p.cache_creation_input_token_cost ?? p.input_cost_per_token) * 1e6,
      write1h:
        (p.cache_creation_input_token_cost_above_1hr ??
          p.cache_creation_input_token_cost ??
          p.input_cost_per_token) * 1e6,
      reasoning: (p.output_cost_per_reasoning_token ?? p.output_cost_per_token) * 1e6,
    };
  }
  if (!Object.keys(models).length) throw new Error("No valid LiteLLM token prices");
  return { version: `litellm-${date}`, asOf: date, sources: [priceUrl], models };
}

const routeAliases: Record<string, string> = {
  "opencode-go": "opencode_go",
  "github-copilot": "github_copilot",
  "google-gemini-cli": "gemini",
  google: "gemini",
};
const aliases: Record<string, string> = {
  "muse-spark-1.3": "meta/muse-spark-1.3",
  "muse-spark-1.3-contributor": "meta/muse-spark-1.3-contributor",
  "claude-sonnet-4.6": "claude-sonnet-4-6",
  "claude-opus-4.6": "claude-opus-4-6",
  "claude-haiku-4.5": "claude-haiku-4-5",
  "claude-sonnet-5.5": "claude-sonnet-5-5",
  "claude-opus-5.5": "claude-opus-5-5",
  "claude-haiku-5.5": "claude-haiku-5-5",
  "gemini-pro": "gemini/gemini-2.5-pro",
  "gemini-flash": "gemini/gemini-2.5-flash",
  "claude-3-5-sonnet-latest": "claude-3-5-sonnet-20241022",
  "claude-3-7-sonnet-latest": "claude-3-7-sonnet-20250219",
};
/** Exact route first; explicit alias; known CLI route stripped; first-party namespaces.
 * Never substring/fuzzy match or choose an arbitrary reseller's rate. */
export function matchModel(model: string, models: PriceTable["models"]): string | undefined {
  const bare = model.replace(/#.*$/, "");
  const slash = bare.indexOf("/");
  const route = bare.slice(0, slash);
  const translated =
    slash >= 0 && routeAliases[route]
      ? `${routeAliases[route]}/${bare.slice(slash + 1)}`
      : undefined;
  const upstream = bare.replace(/^openrouter\//, "");
  const stripped = upstream.replace(
    /^(opencode-go|opencode|openai-codex|openai|anthropic|google|google-gemini-cli)\//,
    "",
  );
  const candidates = [
    model,
    bare,
    translated,
    aliases[bare],
    stripped,
    aliases[stripped],
    `gemini/${stripped}`,
    `anthropic/${stripped}`,
    `openai/${stripped}`,
  ];
  return candidates.find((key): key is string => key !== undefined && Object.hasOwn(models, key));
}
