import type { ToolListing } from "@ace/mcp-server";

/**
 * Whether Codex defers ace's tools, and so how ace lists them to a Codex session. Read from
 * Codex 0.163.0's source (`core/src/tools/spec_plan.rs`, `core/src/mcp_tool_exposure.rs`,
 * `models-manager/src/manager.rs`, `model-provider/src/amazon_bedrock/runtime_catalog.rs`):
 *
 * - Codex defers every MCP tool only when the turn's model metadata says `supports_search_tool`.
 *   Otherwise it loads every listed tool in full on every request: as function tools, or as
 *   declarations in `exec`'s description for code-mode-only models.
 * - Model metadata comes from Codex's catalog. Its own (bundled, refreshed from OpenAI) and one
 *   from `model_catalog_json` match the longest slug the model name starts with, or the same
 *   match after one `provider/` segment. A provider's `model_catalog_url` matches the slug
 *   exactly. A model the catalog lacks (an Ollama or LM Studio model under `--oss`, a custom
 *   provider's own model names) gets fallback metadata without search. Every model in Codex's own
 *   catalog supports search; a custom catalog's metadata is its author's, and `model/list` does
 *   not return `supports_search_tool`, so a model found there is unknown.
 * - The `amazon-bedrock-runtime` provider's catalog turns search off for every model.
 * - `features.code_mode_only_strict_3p_tools` keeps MCP tools deferred in a code-mode-only turn
 *   even without search. A model without catalog metadata is code-mode-only only through
 *   `features.code_mode_only`; Bedrock Runtime's models are code-mode-only by their metadata.
 *
 * Codex fixes a server's tools when it connects and only logs `tools/list_changed`, so a session
 * whose tools would load upfront gets the fixed list (core tools, `tools_find`, `tools_call`).
 */
export interface CodexToolFacts {
  /** The model the thread starts on; absent when Codex picks its catalog default. */
  readonly model?: string | undefined;
  /** `model_provider` from Codex's config; absent means `openai`. */
  readonly provider?: string | undefined;
  /** Which catalog Codex reads model metadata from; absent when its config could not be read. */
  readonly catalogSource?: CodexCatalogSource | undefined;
  /** Model slugs from `model/list` with hidden models; absent when it could not be read. */
  readonly catalog?: readonly string[] | undefined;
  /** `features` from Codex's config. */
  readonly features?: Readonly<Record<string, unknown>> | undefined;
}
/**
 * Codex's own catalog; `model_catalog_json` from its config, which wins over any provider's; or
 * the active provider's `model_catalog_url`.
 */
export type CodexCatalogSource = "codex" | "file" | "provider";

const bedrockRuntime = "amazon-bedrock-runtime";

/** Codex's own lookup: the longest slug the name starts with, then after one namespace. */
export function inCodexCatalog(model: string, catalog: readonly string[]): boolean {
  if (catalog.some((slug) => slug !== "" && model.startsWith(slug))) return true;
  const slash = model.indexOf("/");
  if (slash <= 0) return false;
  const namespace = model.slice(0, slash);
  const rest = model.slice(slash + 1);
  return (
    /^[A-Za-z0-9_-]+$/.test(namespace) &&
    !rest.includes("/") &&
    catalog.some((slug) => slug !== "" && rest.startsWith(slug))
  );
}

/** Whether the config alone decides, so the catalog need not be read. */
export function codexNeedsCatalog(facts: Omit<CodexToolFacts, "catalog">): boolean {
  return (
    facts.catalogSource !== undefined &&
    facts.provider !== bedrockRuntime &&
    facts.model !== undefined
  );
}

/** Whether the turn's model has `supports_search_tool`; undefined when ace cannot tell. */
function modelSearches(facts: CodexToolFacts): boolean | undefined {
  const source = facts.catalogSource;
  if (source === undefined) return undefined;
  if (facts.provider === bedrockRuntime) return false;
  // Codex's default model is one its catalog lists.
  if (facts.model === undefined) return source === "codex" ? true : undefined;
  if (facts.catalog === undefined) return undefined;
  const found =
    source === "provider"
      ? facts.catalog.includes(facts.model)
      : inCodexCatalog(facts.model, facts.catalog);
  if (!found) return false;
  return source === "codex" ? true : undefined;
}

/** True when Codex defers ace's tools for a turn on this model; undefined when unknown. */
export function codexDefersMcpTools(facts: CodexToolFacts): boolean | undefined {
  const searches = modelSearches(facts);
  if (searches !== false) return searches;
  const strict = facts.features?.["code_mode_only_strict_3p_tools"] === true;
  const codeModeOnly =
    facts.provider === bedrockRuntime || facts.features?.["code_mode_only"] === true;
  return strict && codeModeOnly;
}

/**
 * The listing a Codex session connects with. Where Codex defers, or where ace could not tell,
 * every tool is listed as before; where every tool would load upfront, the fixed list.
 */
export function codexToolListing(facts: CodexToolFacts): ToolListing {
  return codexDefersMcpTools(facts) === false ? "static" : "all";
}
