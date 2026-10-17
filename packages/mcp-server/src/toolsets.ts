import type { Principal } from "./credentials.ts";

/**
 * Clients that load every listed tool upfront (OpenCode, Cursor, Pi, ACP) send this header and
 * see only ace's core tools until the session needs more. Claude Code and Codex defer MCP tools
 * behind their own tool search, so they omit it and see the whole catalogue.
 */
export const coreToolsHeader = { name: "X-Ace-Tools", value: "core" } as const;

/** The entry points every session lists: one per task family, plus status and the guides. */
export const coreTools: ReadonlySet<string> = new Set([
  "ace_status",
  "ace_guide",
  "ace_ask",
  "delegate_task",
  "ace_wait",
  "browser_open",
  "ace_html_render",
  "ace_context",
  "ace_thread_read",
  "ace_thread_link_pr",
  "ace_note_add",
  "screen_open_app",
]);

/** Using one of these opens its family: the next steps after it are its toolset's tools. */
const entryPoints: ReadonlyMap<string, string> = new Map([
  ["delegate_task", "ace-agents"],
  ["browser_open", "ace-browser"],
  ["screen_open_app", "ace-computer-use"],
]);

/** The guide topic whose toolset a tool belongs to. Every ace tool belongs to exactly one. */
export function toolsetOf(name: string): string {
  if (name.startsWith("browser_")) return "ace-browser";
  if (name.startsWith("screen_") || name.startsWith("sim_")) return "ace-computer-use";
  if (
    name === "delegate_task" ||
    name === "ace_wait" ||
    name === "ace_ask" ||
    name === "ace_machines" ||
    name === "ace_list_agents" ||
    /^ace_agents?_/.test(name) ||
    name.startsWith("ace_device_")
  )
    return "ace-agents";
  if (name === "ace_html_render") return "visualize";
  return "ace-threads";
}

/**
 * The toolsets a core-mode session has opened. Reading a guide opens its toolset, and so does
 * using a family's entry point (opening the browser opens the browser tools). Open toolsets
 * last as long as the credential.
 */
export class OpenToolsets {
  private readonly open = new WeakMap<Principal, Set<string>>();
  /** True when this call opened a toolset the session did not have. */
  opened(principal: Principal, tool: string, args: unknown): boolean {
    const topic = tool === "ace_guide" ? guideTopic(args) : entryPoints.get(tool);
    if (topic === undefined) return false;
    const set = this.open.get(principal) ?? new Set<string>();
    this.open.set(principal, set);
    if (set.has(topic)) return false;
    set.add(topic);
    return true;
  }
  /** Whether a core-mode session lists this tool now. */
  lists(principal: Principal, tool: string): boolean {
    return coreTools.has(tool) || (this.open.get(principal)?.has(toolsetOf(tool)) ?? false);
  }
}

function guideTopic(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || !("topic" in args)) return undefined;
  return typeof args.topic === "string" ? args.topic : undefined;
}
