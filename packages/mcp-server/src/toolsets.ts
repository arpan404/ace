import type { Principal } from "./credentials.ts";
import { bareToolName } from "./tool-names.ts";

/**
 * Clients that load every listed tool upfront and refresh their list on `tools/list_changed`
 * send this header and see only ace's core tools until the session needs more. Verified for
 * OpenCode 2.0.22 (debounced reload on the notification) and Pi (ace's extension re-registers).
 * Cursor's SDK and generic ACP agents do not refresh, so they omit it and list every tool:
 * a tool a client never lists is a tool its model can never call. Claude Code and Codex defer
 * MCP tools behind their own tool search and omit it too.
 */
export const coreToolsHeader = { name: "X-Ace-Tools", value: "core" } as const;

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
 * using a family's entry point (opening the browser opens the browser tools). Open toolsets
 * last as long as the credential.
 */
export class OpenToolsets {
  private readonly open = new WeakMap<Principal, Set<string>>();
  /** True when this call opened a toolset the session did not have. */
  opened(principal: Principal, tool: string, args: unknown): boolean {
    const topic = openedToolset(tool, args);
    if (topic === undefined) return false;
    const set = this.open.get(principal) ?? new Set<string>();
    this.open.set(principal, set);
    if (set.has(topic)) return false;
    set.add(topic);
    return true;
  }
  /** Whether a core-mode session lists this tool now. A tool without a family is always listed. */
  lists(principal: Principal, tool: string, toolset: string | undefined): boolean {
    return (
      coreTools.has(bareToolName(tool)) ||
      toolset === undefined ||
      (this.open.get(principal)?.has(toolset) ?? false)
    );
  }
}

function guideTopic(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || !("topic" in args)) return undefined;
  return typeof args.topic === "string" ? args.topic : undefined;
}
