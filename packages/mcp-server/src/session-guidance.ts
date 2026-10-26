import type { AccessMode, ProviderKind } from "@ace/protocol";
import { aceGuidance } from "./status.ts";
import { codexPrefix } from "./codex-guidance.ts";
import type { ToolListing } from "./toolsets.ts";

/** Providers whose CLI shows MCP server instructions to the model; the rest opt out. */
const readsServerInstructions = new Set<ProviderKind>(["claude", "opencode", "acp", "antigravity"]);
/** What the daemon knows about this session when it injects guidance. */
export interface SessionGuidance {
  /** The session brief (facts), rendered by `renderBrief`. */
  brief?: string | undefined;
  /** Enabled ace groups. Omitted: guidance for every group. */
  groups?: readonly string[] | undefined;
  /** The person's roles at session start, rendered by `renderRoles`; absent when none is set. */
  roles?: string | undefined;
  /** Bare names of the ace tools this session can call, for clients that never see them. */
  tools?: readonly string[] | undefined;
  /** The thread's ace access mode at session start; null or absent when not known. */
  access?: AccessMode | null | undefined;
  /** How this session's client lists ace tools; omitted: the provider's usual listing. */
  listing?: ToolListing | undefined;
}
/** Where the provider natively lists ace's shipped skills; the rest read them via `guide`. */
const skills = "The ace guides except offshift are also installed as skills.";
/** How each provider lists ace tools unless the session says otherwise (`injection.ts`). */
const usualListing: Record<ProviderKind, ToolListing> = {
  codex: "all",
  claude: "all",
  opencode: "core",
  pi: "core",
  cursor: "static",
  antigravity: "all",
  acp: "static",
};
/** The listing a provider's sessions use unless the daemon knows better (an ACP agent's CLI). */
export function usualToolListing(provider: ProviderKind): ToolListing {
  return usualListing[provider];
}
/**
 * How each provider spells ace's bare tool names (its MCP namespace for server `ace`), then
 * where it lists ace's skills. Claude's names are in the `all` reach line; Codex has its recipe.
 */
const naming: Record<ProviderKind, string> = {
  codex: "",
  claude: "",
  opencode: `OpenCode names ace tools ace_<tool> (ace_guide, ace_delegate). ${skills} Load them with your skill tool.`,
  cursor: `ace tools come from the ace MCP server. ${skills}`,
  antigravity: "ace tools come from the ace MCP server.",
  acp: "ace tools come from the ace MCP server.",
  pi: `ace tools are your ace_<tool> extension tools: guide is ace_guide and delegate is ace_delegate. ${skills}`,
};
/**
 * How to reach an ace tool the always-on guidance names but this session's list may not hold
 * (thread_start and thread_control live in the ace-threads family).
 */
const reach: Record<ToolListing, string> = {
  all: "ace tools are mcp__ace__<tool>, mostly deferred (browser_open and html_render too): load one by exact name with your tool search before calling it, e.g. select:mcp__ace__thread_start.",
  core: "Your ace list starts small: guide or tools_find adds a family (thread_start and thread_control come with ace-threads); call one not listed yet with tools_call {name, arguments}.",
  static:
    "Your ace list is fixed: call other ace tools, such as thread_start or thread_control, with tools_call {name, arguments}; tools_find or guide gives the schema.",
};
/**
 * How a deferring provider other than Claude reaches a tool it lists but has not loaded.
 * Antigravity loads only always-load tools and keeps each other tool's definition in a file.
 */
const deferredReach: Partial<Record<ProviderKind, string>> = {
  antigravity:
    'Most ace tools are deferred: read the tool\'s definition file, then call it with call_mcp_tool (ServerName "ace", ToolName, Arguments), e.g. ToolName thread_start or browser_open.',
};
/** The read tools a read-only session is told about; the full set is `readOnlyAceTools`. */
const namedReadTools = [
  "context",
  "guide",
  "tools_find",
  "thread_read",
  "threads_find",
  "agents_status",
  "wait",
] as const;
const readOnly = `This session is read-only: ace's read tools (${namedReadTools.join(", ")}) still work; your provider decides on any that change things.`;

/**
 * Guidance for the provider's own system/developer channel. Each provider receives ace's
 * always-on guidance once: through MCP server instructions where the CLI shows them, and
 * through this channel otherwise. What varies by provider, listing or access mode lives here,
 * never in the shared server text. Rendered once per session, so the provider's cached prefix
 * never changes under it.
 */
export function developerInstructions(
  provider: ProviderKind,
  session: SessionGuidance = {},
): string {
  const listing = session.listing ?? usualListing[provider];
  return [
    readsServerInstructions.has(provider) ? undefined : aceGuidance(session.groups, session.tools),
    // Codex's recipe replaces the naming and reach lines: its models call ace from exec.
    provider === "codex" ? codexPrefix(session.tools, skills) : naming[provider],
    provider === "codex"
      ? undefined
      : listing === "all"
        ? (deferredReach[provider] ?? reach.all)
        : reach[listing],
    provider === "claude" ? skills : undefined,
    session.access === "read-only" ? readOnly : undefined,
    session.roles,
    session.brief,
  ]
    .filter(Boolean)
    .join("\n");
}
