import type { Principal } from "./credentials.ts";
import { aceToolDispatch, aceToolSearch, bareToolName } from "./tool-names.ts";

/**
 * How a client lists ace's tools, chosen by its `X-Ace-Tools` header:
 * - `all` (no header): Claude Code and Codex defer MCP tools behind their own tool search, so
 *   every tool is listed and `tools_find` loads upfront.
 * - `core`: clients that load every listed tool upfront and reload on `tools/list_changed`
 *   (OpenCode 2.0.22 debounces a reload; Pi's extension re-registers). They start with the core
 *   tools and `tools_find`; a guide, an entry point or a search adds a family.
 * - `static`: clients that never reload (Cursor's SDK caches its list per connection; most ACP
 *   agents and Antigravity never refresh). They keep the core tools and `tools_find`, and reach
 *   every other tool through `tools_call`.
 */
export type ToolListing = "all" | "core" | "static";
export const coreToolsHeader = { name: "X-Ace-Tools", value: "core" } as const;
export const staticToolsHeader = { name: "X-Ace-Tools", value: "static" } as const;

/** The listing a client asked for; anything unrecognised lists every tool. */
export function toolListing(header: string | null | undefined): ToolListing {
  if (header === coreToolsHeader.value) return "core";
  return header === staticToolsHeader.value ? "static" : "all";
}

/**
 * What a core-mode session lists before it opens a family: the tools the instructions name as
 * entry points. Compared by bare name, so a toolkit's spelling never matters.
 */
export const coreTools: ReadonlySet<string> = new Set([
  "context",
  "guide",
  "delegate",
  "wait",
  "ask",
  "note_add",
  "thread_link_pr",
  "browser_open",
  "html_render",
  "screen_open_app",
]);

/** Using one of these opens its family: the next steps after it are its toolset's tools. */
const entryPoints: ReadonlyMap<string, string> = new Map([
  ["delegate", "ace-agents"],
  ["browser_open", "ace-browser"],
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
   * Whether this session lists a tool now. `tools_call` is listed only where the client never
   * reloads; in core mode a tool without a family is always listed.
   */
  lists(
    principal: Principal,
    listing: ToolListing,
    tool: string,
    toolset: string | undefined,
  ): boolean {
    const bare = bareToolName(tool);
    if (bare === aceToolDispatch) return listing === "static";
    if (listing === "all" || bare === aceToolSearch || coreTools.has(bare)) return true;
    if (listing === "static") return false;
    return toolset === undefined || (this.open.get(principal)?.has(toolset) ?? false);
  }
}

function guideTopic(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || !("topic" in args)) return undefined;
  return typeof args.topic === "string" ? args.topic : undefined;
}
