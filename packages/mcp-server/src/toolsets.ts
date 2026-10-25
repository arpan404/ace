import type { Principal } from "./credentials.ts";
import { aceToolDispatch, aceToolSearch, bareToolName } from "./tool-names.ts";

/**
 * How a client lists ace's tools, chosen by its `X-Ace-Tools` header:
 * - `all` (no header): Claude Code, Codex and Antigravity defer MCP tools (behind a tool search,
 *   or Antigravity's definition files), so every tool is listed and `tools_find` loads upfront.
 * - `core`: clients that load every listed tool upfront and reload on `tools/list_changed`
 *   (OpenCode 2.0.32 debounces a reload; Pi's extension re-registers; Gemini CLI reloads). They
 *   start with the core tools, `tools_find` and `tools_call`; a guide, an entry point or a search
 *   adds a family, and `tools_call` reaches a found tool before the reload lands.
 * - `static`: clients that never reload (Cursor's SDK caches its list per connection; ACP agents
 *   not known to refresh). They keep the core tools and `tools_find`, and
 *   reach every other tool through `tools_call`.
 */
export type ToolListing = "all" | "core" | "static";
export const coreToolsHeader = { name: "X-Ace-Tools", value: "core" } as const;
export const staticToolsHeader = { name: "X-Ace-Tools", value: "static" } as const;

/**
 * Who the client is, where its model meets ace's tools differently from what its listing says.
 * Codex lists every tool, but its code-mode models see only `exec`: they call ace tools as
 * `tools.mcp__ace__<name>(args)` without ever seeing an input schema, so `guide` and `tools_find`
 * return schemas and that call form to it.
 */
export type AceClient = "codex";
export const codexClientHeader = { name: "X-Ace-Client", value: "codex" } as const;
export function aceClient(header: string | null | undefined): AceClient | undefined {
  return header === codexClientHeader.value ? "codex" : undefined;
}

/**
 * How long a client lets one tool call run before it cancels the call itself, sent as whole
 * seconds in `X-Ace-Call-Budget`. Cursor's SDK (1.0.35) cancels every MCP call after 60 seconds
 * and offers no setting to raise it, so a `wait` of 120 seconds died at 60 and the agent read a
 * delegation that had started as a failure. Tools that wait (`wait`, `delegate` with
 * `waitSeconds`, `ask`) end within the budget and report a timeout the agent can wait on again.
 */
export const callBudgetHeader = { name: "X-Ace-Call-Budget" } as const;
export function callBudgetSeconds(header: string | null | undefined): number | undefined {
  if (!header || !/^\d{1,4}$/.test(header.trim())) return undefined;
  const seconds = Number(header.trim());
  return seconds >= 5 && seconds <= 600 ? seconds : undefined;
}
/** A requested wait, cut to the client's call budget when it has one. */
export function withinCallBudget(seconds: number, budget: number | undefined): number {
  return budget === undefined ? seconds : Math.min(seconds, budget);
}

/** The listing a client asked for; anything unrecognised lists every tool. */
export function toolListing(header: string | null | undefined): ToolListing {
  if (header === coreToolsHeader.value) return "core";
  return header === staticToolsHeader.value ? "static" : "all";
}
/** The header that asks for a listing; listing every tool needs none. */
export function toolListingHeader(
  listing: ToolListing,
): typeof coreToolsHeader | typeof staticToolsHeader | undefined {
  if (listing === "core") return coreToolsHeader;
  return listing === "static" ? staticToolsHeader : undefined;
}

/**
 * The listing for an ACP agent, by the reviewed CLI behind it (`acpAgentCli`). ACP leaves tool
 * refresh to each agent:
 * - Gemini CLI (0.43, ace's floor for it) sends every tool upfront and reloads on
 *   `tools/list_changed`, so it starts with the core tools and grows.
 * - claude-agent-acp runs the Claude Agent SDK, which defers MCP tools behind its own tool
 *   search and honours `anthropic/alwaysLoad`, as Claude Code does.
 * - Antigravity (checked live on 1.4.2) loads only tools marked `antigravity/alwaysLoad` in full;
 *   it writes every other tool's definition to a file its agent reads, then calls the tool
 *   through its own `call_mcp_tool`. So it lists every tool, as Claude does.
 * - Every other agent stays static: a conservative default for agents not verified to reload,
 *   not a claim that they never refresh.
 */
export function acpToolListing(cli: string | undefined): ToolListing {
  if (cli === "gemini") return "core";
  return cli === "claude-acp" || cli === "antigravity" ? "all" : "static";
}

/**
 * What a core-mode session lists before it opens a family: the entry points the instructions
 * name, within the per-request budget (mcp-agent-budget.process.test.ts). Compared by bare name,
 * so a toolkit's spelling never matters.
 */
export const coreTools: ReadonlySet<string> = new Set([
  "context",
  "guide",
  "delegate",
  "wait",
  "ask",
  "note_add",
  "thread_link_pr",
  // thread_start, thread_control, projects_find and agent_message cost about 1,500 tokens on
  // every request of a client that loads tools upfront: they stay in the ace-threads and
  // ace-agents families, opened by their guides, tools_find, or reached through tools_call.
  "browser_open",
  "html_render",
  // macOS lists the background engine's screen_state; other platforms keep screen_open_app.
  "screen_state",
  "screen_open_app",
]);

/** Using one of these opens its family: the next steps after it are its toolset's tools. */
const entryPoints: ReadonlyMap<string, string> = new Map([
  ["delegate", "ace-agents"],
  ["browser_open", "ace-browser"],
  ["screen_state", "ace-computer-use"],
  ["screen_open_app", "ace-computer-use"],
]);

/** The family a call opens: a guide's topic, or an entry point's family. */
export function openedToolset(tool: string, args: unknown): string | undefined {
  const bare = bareToolName(tool);
  return bare === "guide" ? guideTopic(args) : entryPoints.get(bare);
}

/**
 * The toolsets a core-mode session has opened. Reading a guide opens its toolset, and so does
 * using a family's entry point (opening the browser opens the browser tools) or finding a
 * family's tools with `tools_find`. Open toolsets last as long as the credential.
 */
export class OpenToolsets {
  private readonly open = new WeakMap<Principal, Set<string>>();
  /** True when this call opened a toolset the session did not have. */
  opened(principal: Principal, tool: string, args: unknown): boolean {
    const topic = openedToolset(tool, args);
    return topic !== undefined && this.add(principal, [topic]);
  }
  /** Opens these families; true when any of them was new. */
  add(principal: Principal, topics: readonly string[]): boolean {
    const set = this.open.get(principal) ?? new Set<string>();
    this.open.set(principal, set);
    const before = set.size;
    for (const topic of topics) set.add(topic);
    return set.size > before;
  }
  /**
   * Whether this session lists a tool now. `tools_call` is listed wherever the list is not
   * complete; in core mode a tool without a family is always listed.
   */
  lists(
    principal: Principal,
    listing: ToolListing,
    tool: string,
    toolset: string | undefined,
  ): boolean {
    const bare = bareToolName(tool);
    if (bare === aceToolDispatch) return dispatches(listing);
    if (listing === "all" || bare === aceToolSearch || coreTools.has(bare)) return true;
    if (listing === "static") return false;
    return toolset === undefined || (this.open.get(principal)?.has(toolset) ?? false);
  }
}

/**
 * Whether a session is offered `tools_call`: wherever its list lacks tools. A core client's list
 * grows, but a found tool may be listed a model step late; a client listing every tool calls
 * each one directly.
 */
export function dispatches(listing: ToolListing): boolean {
  return listing !== "all";
}

function guideTopic(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || !("topic" in args)) return undefined;
  return typeof args.topic === "string" ? args.topic : undefined;
}
