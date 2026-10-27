import type { ToolListing } from "@ace/mcp-server";

/**
 * Whether Codex defers ace's tools, and so how ace lists them to a Codex session. Read from
 * Codex 0.163.0's source (`core/src/tools/spec_plan.rs`, `core/src/mcp_tool_exposure.rs`,
 * `models-manager/src/manager.rs`, `model-provider/src/amazon_bedrock/runtime_catalog.rs`):
 *
 * - Codex defers every MCP tool only when the turn's model metadata says `supports_search_tool`.
 *   Otherwise it loads every listed tool in full on every request: as function tools, or as
 *   declarations in `exec`'s description for code-mode-only models.
 * - Model metadata comes from Codex's catalog: the longest catalog slug the model name starts
 *   with, or the same match after one `provider/` segment. A model the catalog lacks (an Ollama
 *   or LM Studio model under `--oss`, a custom provider's own model names) gets fallback metadata
 *   without search. Every model in Codex's bundled catalog supports search.
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
  /** Model slugs from `model/list` with hidden models; absent when it could not be read. */
  readonly catalog?: readonly string[] | undefined;
  /** `features` from Codex's config. */
  readonly features?: Readonly<Record<string, unknown>> | undefined;
}

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

/** True when Codex defers ace's tools for a turn on this model; undefined when unknown. */
export function codexDefersMcpTools(facts: CodexToolFacts): boolean | undefined {
  const bedrock = facts.provider === bedrockRuntime;
  const searches = bedrock
    ? false
    : facts.model === undefined
      ? true
      : facts.catalog === undefined
        ? undefined
        : inCodexCatalog(facts.model, facts.catalog);
  if (searches !== false) return searches;
  const strict = facts.features?.["code_mode_only_strict_3p_tools"] === true;
  const codeModeOnly = bedrock || facts.features?.["code_mode_only"] === true;
  return strict && codeModeOnly;
}

/**
 * The listing a Codex session connects with. Where Codex defers, or where ace could not tell,
 * every tool is listed as before; where every tool would load upfront, the fixed list.
 */
export function codexToolListing(facts: CodexToolFacts): ToolListing {
  return codexDefersMcpTools(facts) === false ? "static" : "all";
}
