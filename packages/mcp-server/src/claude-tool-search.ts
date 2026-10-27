import type { ToolListing } from "./toolsets.ts";

/**
 * Whether Claude Code will defer MCP tools behind its tool search, read from Claude Code 2.1.311
 * (the tool-search mode, the per-request decision and the API-provider choice in its bundle) and
 * its MCP docs ("Configure tool search", "Tool search through an LLM gateway"). The CLI decides
 * per request; these are the facts ace can see before it launches a session.
 */
export interface ClaudeToolSearchFacts {
  /** The environment Claude Code runs with: settings `env` applied over the launch env. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The model the session's requests use; absent: `ANTHROPIC_MODEL`, else Claude Code's default. */
  readonly model?: string | undefined;
  /** Permission rules deny `ToolSearch`, so MCP tools load upfront. */
  readonly toolSearchDenied?: boolean | undefined;
}

export type ClaudeToolSearchReason =
  | "experimental-betas-disabled"
  | "disabled-by-env"
  | "tool-search-denied"
  | "model-unsupported"
  | "vertex-model-unsupported"
  | "auto-threshold"
  | "foundry-deployment"
  | "gateway";

/**
 * `on`: every MCP tool not marked always-load is deferred. `off`: every tool loads upfront.
 * `uncertain`: the CLI settles it at run time (a token threshold, or an endpoint that may refuse
 * the tool-search beta and make Claude Code load every tool upfront for the conversation).
 */
export type ClaudeToolSearch =
  | { readonly state: "on" }
  | { readonly state: "off" | "uncertain"; readonly reason: ClaudeToolSearchReason };

/** Models whose name contains one of these never get tool search (the CLI's default list). */
const unsupportedModels = [
  "claude-3-opus",
  "claude-3-sonnet",
  "claude-3-haiku",
  "claude-3-5-sonnet",
  "claude-3-5-haiku",
  "claude-3-7-sonnet",
];

export function claudeToolSearch(facts: ClaudeToolSearchFacts): ClaudeToolSearch {
  const { env } = facts;
  // Strips the tool-search beta; only managed settings can force it back on.
  if (truthy(env["CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS"]))
    return { state: "off", reason: "experimental-betas-disabled" };
  const mode = searchMode(env["ENABLE_TOOL_SEARCH"]);
  if (mode === "off") return { state: "off", reason: "disabled-by-env" };
  if (facts.toolSearchDenied) return { state: "off", reason: "tool-search-denied" };
  const model = (facts.model || env["ANTHROPIC_MODEL"])?.toLowerCase();
  if (model && unsupportedModels.some((name) => model.includes(name)))
    return { state: "off", reason: "model-unsupported" };
  const provider = apiProvider(env);
  if (provider === "vertex" && model && vertexRejects(model))
    return { state: "off", reason: "vertex-model-unsupported" };
  if (mode === "auto") return { state: "uncertain", reason: "auto-threshold" };
  // Foundry deployments hosted on Azure reject tool search; the CLI learns it from a 400.
  if (provider === "foundry") return { state: "uncertain", reason: "foundry-deployment" };
  // A gateway may refuse `defer_loading`; the CLI then loads every tool upfront. Before 2.1.304
  // tool search was off behind a custom ANTHROPIC_BASE_URL unless ENABLE_TOOL_SEARCH said on.
  if (provider === "gateway" || (provider === "firstParty" && customBaseUrl(env)))
    return { state: "uncertain", reason: "gateway" };
  return { state: "on" };
}

/**
 * The listing ace gives a Claude Code session. With tool search on, every tool is listed and
 * deferred. Otherwise each listed tool costs its full definition on every request, so the session
 * gets the core listing: Claude Code reloads on `tools/list_changed` (2.1.311 refreshes the tool
 * list on it in `-p` and SDK sessions too), so families open on use.
 */
export function claudeToolListing(facts: ClaudeToolSearchFacts): ToolListing {
  return claudeToolSearch(facts).state === "on" ? "all" : "core";
}

/**
 * The listing after the session's facts change (a model switch). It only ever narrows: a core
 * session stays core, which still works when tool search is on, so the server never has to
 * widen a list the model has already been told is small.
 */
export function claudeToolListingAfter(
  current: ToolListing,
  facts: ClaudeToolSearchFacts,
): ToolListing {
  return current === "all" ? claudeToolListing(facts) : current;
}

/** `ENABLE_TOOL_SEARCH`, read as the CLI reads it: unset or unrecognised means on. */
function searchMode(value: string | undefined): "on" | "off" | "auto" {
  if (!value) return "on";
  if (value.startsWith("auto:")) {
    const percent = Number(value.slice(5));
    if (Number.isNaN(percent)) return "auto";
    const clamped = Math.max(0, Math.min(100, percent));
    if (clamped === 0) return "on";
    return clamped === 100 ? "off" : "auto";
  }
  if (value === "auto") return "auto";
  if (truthy(value)) return "on";
  return falsy(value) ? "off" : "on";
}

type ApiProvider = "firstParty" | "gateway" | "vertex" | "foundry" | "other";
/** The API the CLI sends requests to, in the order it checks its switches. */
function apiProvider(env: ClaudeToolSearchFacts["env"]): ApiProvider {
  if (truthy(env["CLAUDE_CODE_USE_GATEWAY"])) return "gateway";
  if (truthy(env["CLAUDE_CODE_USE_BEDROCK"])) return "other";
  if (truthy(env["CLAUDE_CODE_USE_FOUNDRY"])) return "foundry";
  for (const name of [
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
    "CLAUDE_CODE_USE_MANTLE",
  ])
    if (truthy(env[name])) return "other";
  return truthy(env["CLAUDE_CODE_USE_VERTEX"]) ? "vertex" : "firstParty";
}

/** Vertex serving stacks before the 4.5 generation reject the tool-search beta. */
function vertexRejects(model: string): boolean {
  const id = model.replace(/\[[^\]]*\]$/, "").replace(/[@-]\d{8}$/, "");
  if (/^claude-3(-|$)/.test(id)) return true;
  if (!/^claude-(opus|sonnet|haiku)-\d/.test(id)) return false;
  // Anything after the version the CLI cannot read counts as too old.
  const version = /^claude-[a-z]+-(\d+(?:-\d+)*)$/.exec(id)?.[1];
  if (!version) return true;
  const [major = 0, minor = 0] = version.split("-").map(Number);
  return major < 4 || (major === 4 && minor < 5);
}

function customBaseUrl(env: ClaudeToolSearchFacts["env"]): boolean {
  const url = env["ANTHROPIC_BASE_URL"];
  if (!url) return false;
  try {
    return new URL(url).host !== "api.anthropic.com";
  } catch {
    return true;
  }
}

function truthy(value: string | undefined): boolean {
  return !!value && ["1", "true", "yes", "on"].includes(value.toLowerCase().trim());
}
function falsy(value: string): boolean {
  return ["0", "false", "no", "off"].includes(value.toLowerCase().trim());
}
