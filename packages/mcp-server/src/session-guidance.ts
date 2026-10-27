import type { AccessMode, ProviderKind } from "@ace/protocol";
import { aceGuidance } from "./status.ts";
import { codexPrefix } from "./codex-guidance.ts";
import { cursorToolListing, type ToolListing } from "./toolsets.ts";

/**
 * Providers whose CLI shows MCP server instructions to the model; the rest get ace's guidance in
 * their own channel. Antigravity only files them beside its tool definitions (`instructions.md`),
 * unread unless its model opens that file. An ACP agent's session says what its CLI does
 * (`acpShowsServerInstructions`).
 */
const readsServerInstructions = new Set<ProviderKind>(["claude", "opencode", "acp"]);
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
  /** Whether this session's client shows ace's MCP server instructions; omitted: the provider's usual. */
  serverInstructions?: boolean | undefined;
}
/** Where the provider natively lists ace's shipped skills; the rest read them via `guide`. */
const skills = "ace's guides except offshift are also installed as skills.";
/** Claude loads `guide` on demand only: its skills are the same text (`registry.ts`). */
const claudeSkills =
  "ace's guides except offshift are installed as skills; use them for guide <topic>.";
/** How each provider lists ace tools unless the session says otherwise (`injection.ts`). */
const usualListing: Record<ProviderKind, ToolListing> = {
  codex: "all",
  claude: "all",
  opencode: "core",
  pi: "core",
  // Cursor's SDK keeps its MCP meta tool on: names only, every listed tool callable.
  cursor: cursorToolListing(true),
  antigravity: "core",
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
  // Claude's list can narrow to core mid-session (ADR 0086), dropping its tool search; the
  // prompt cannot change then, so the line also names the way that works on the core list.
  all: "Most ace tools are deferred, wait, guide and tools_find too: load one with your tool search (select:mcp__ace__thread_start); with none, call it via tools_call {name, arguments}.",
  core: "Your ace list starts small: guide or tools_find adds a family (thread_start and thread_control come with ace-threads); call one not listed yet with tools_call {name, arguments}.",
  static:
    "Your ace list is fixed: call other ace tools, such as thread_start or thread_control, with tools_call {name, arguments}; tools_find or guide gives the schema.",
};
/**
 * How a deferring provider other than Claude reaches a tool it lists but has not loaded.
 * Antigravity loads only always-load tools and keeps each other tool's definition in a file.
 * Cursor shows only tool names and reaches every MCP tool through its own GetMcpTools and
 * CallMcpTool.
 */
const deferredReach: Partial<Record<ProviderKind, string>> = {
  cursor:
    'ace tools are listed by name only: GetMcpTools (server "ace", toolName) gives a schema and tools_find finds one by task; call it with CallMcpTool, e.g. thread_start or browser_open.',
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
  const served = session.serverInstructions ?? readsServerInstructions.has(provider);
  return [
    served ? undefined : aceGuidance(session.groups, session.tools),
    // Codex's recipe replaces the naming and reach lines: its models call ace from exec.
    provider === "codex" ? codexPrefix(session.tools, skills, listing) : naming[provider],
    provider === "codex"
      ? undefined
      : listing === "all"
        ? (deferredReach[provider] ?? reach.all)
        : reach[listing],
    provider === "antigravity" && listing !== "all"
      ? 'Read a listed tool\'s definition file if needed, then use call_mcp_tool (ServerName "ace", ToolName, Arguments).'
      : undefined,
    provider === "claude" ? claudeSkills : undefined,
    session.access === "read-only" ? readOnly : undefined,
    session.roles,
    session.brief,
  ]
    .filter(Boolean)
    .join("\n");
}

/** An actionable startup error when Gemini's native folder trust blocks the session. */
export function geminiUntrustedGuidance(folder: string, denied: boolean): string {
  const fix = denied
    ? "Change the earlier Don't trust choice with /permissions in an interactive gemini session there."
    : 'Run gemini in that folder once and choose "Trust folder".';
  return `Gemini CLI does not trust ${folder}, so ace cannot start a session with its tools there. ${fix} Then retry this turn in ace.`;
}
