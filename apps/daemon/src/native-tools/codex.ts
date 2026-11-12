import { resolve } from "node:path";
import {
  codexToolEntryNames,
  codexToolOverrides,
  emptyCodexToolTables,
  type CodexToolSource,
  type CodexToolSourceProblem,
  type CodexToolTables,
} from "@ace/plugins";
import type { NativeToolSource, NativeToolStatus } from "@ace/protocol";

/*
 * Pure rules for Codex's own tools (ADR 0128): what a launch adds from the tool source, and
 * which of computer use, Chrome and the in-app browser the selected account can use.
 */

const problemWords: Record<CodexToolSourceProblem, string> = {
  missing_folder: "The Codex tool folder doesn't exist",
  missing_config: "The Codex tool folder has no config.toml",
  unreadable_config: "ace can't read config.toml in the Codex tool folder",
  malformed_config: "config.toml in the Codex tool folder doesn't parse",
};

export function toolSourceProblem(source: CodexToolSource): string | undefined {
  return source.ok ? undefined : problemWords[source.problem];
}

function sameFolder(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

export interface CodexToolLaunch {
  /** `-c` overrides, placed before `app-server`. */
  args: string[];
  /** `table.key` names for logs; never values. */
  entries: string[];
  /** Why the source added nothing, when it should have. */
  problem?: string;
}

/** What a Codex launch from `homeDir` adds: nothing when that home is the tool source itself. */
export function codexToolLaunch(source: CodexToolSource, homeDir: string): CodexToolLaunch {
  if (sameFolder(source.dir, homeDir)) return { args: [], entries: [] };
  if (!source.ok) return { args: [], entries: [], problem: problemWords[source.problem] };
  return { args: codexToolOverrides(source.tables), entries: codexToolEntryNames(source.tables) };
}

/**
 * The tables a Codex launch from `homeDir` ends up with: the account home's own config, each
 * source entry replacing the one of the same name, as the `-c` overrides do.
 */
export function effectiveCodexTools(
  source: CodexToolSource,
  homeDir: string,
  home: CodexToolSource,
): CodexToolTables {
  if (sameFolder(source.dir, homeDir)) return source.ok ? source.tables : emptyCodexToolTables;
  const base = home.ok ? home.tables : emptyCodexToolTables;
  const over = source.ok ? source.tables : emptyCodexToolTables;
  return {
    marketplaces: { ...base.marketplaces, ...over.marketplaces },
    plugins: { ...base.plugins, ...over.plugins },
    mcp_servers: { ...base.mcp_servers, ...over.mcp_servers },
  };
}

/** The `node_repl` MCP server that hosts Codex's computer use, Chrome and browser plugins. */
export type NodeRepl = { state: "missing" | "disabled" } | { state: "configured"; command: string };

export function nodeRepl(tables: CodexToolTables): NodeRepl {
  const entry = tables.mcp_servers["node_repl"];
  if (!entry) return { state: "missing" };
  if (entry["enabled"] === false) return { state: "disabled" };
  const command = entry["command"];
  return typeof command === "string" && command !== ""
    ? { state: "configured", command }
    : { state: "missing" };
}

export interface CodexToolFacts {
  tables: CodexToolTables;
  /** Why the tool source added nothing, when it should have. */
  sourceProblem?: string;
  /** `node_repl`'s program: found, not found, or a bare name ace can't check. */
  program: "found" | "not_found" | "unchecked" | "none";
  /** The ChatGPT app's browser pipe is in the environment Codex runs with. */
  inAppBrowserPipe: boolean;
}

const tools = [
  { id: "computer-use", label: "Computer use", plugin: /^(unified-)?computer-use@/ },
  { id: "chrome", label: "Chrome", plugin: /^chrome@/ },
  { id: "browser", label: "In-app browser", plugin: /^browser@/ },
] as const;

function pluginOn(tables: CodexToolTables, pattern: RegExp): boolean {
  return Object.entries(tables.plugins).some(
    ([id, entry]) => pattern.test(id) && entry["enabled"] !== false,
  );
}

function hostProblem(
  facts: CodexToolFacts,
): Pick<NativeToolStatus, "state" | "reason"> | undefined {
  const repl = nodeRepl(facts.tables);
  if (repl.state === "missing")
    return { state: "unavailable", reason: "Codex's node_repl tool server isn't set up" };
  if (repl.state === "disabled")
    return { state: "unavailable", reason: "Codex's node_repl tool server is turned off" };
  if (facts.program === "not_found")
    return { state: "unavailable", reason: "node_repl's program wasn't found" };
  if (facts.program === "unchecked")
    return { state: "unknown", reason: "ace can't check node_repl's program" };
  return undefined;
}

/** Pure: each Codex tool's state for the selected account. */
export function codexNativeTools(facts: CodexToolFacts): NativeToolStatus[] {
  return tools.map(({ id, label, plugin }) => {
    if (!pluginOn(facts.tables, plugin))
      return {
        id,
        label,
        state: "unavailable",
        reason: facts.sourceProblem ?? "Not turned on in Codex",
      };
    if (id === "browser" && !facts.inAppBrowserPipe)
      return {
        id,
        label,
        state: "unavailable",
        reason: "Needs the ChatGPT app; Chrome and ace's browser still work",
      };
    return { id, label, state: "ready", ...hostProblem(facts) };
  });
}

/** The tool source row for Settings. */
export function codexToolSourceStatus(source: CodexToolSource): NativeToolSource {
  const reason = toolSourceProblem(source);
  return { path: source.dir, usable: source.ok, ...(reason ? { reason } : {}) };
}
