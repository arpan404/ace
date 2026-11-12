import { resolve } from "node:path";
import {
  codexToolEntryNames,
  codexToolOverrides,
  emptyCodexToolTables,
  mergeCodexToolTables,
  relocateCodexHome,
  type CodexToolSource,
  type CodexToolSourceProblem,
  type CodexToolTables,
} from "@ace/plugins";
import type { NativeToolSource, NativeToolStatus } from "@ace/protocol";

/*
 * Pure rules for Codex's own tools (ADR 0138): what a launch adds from the tool source, and
 * which of computer use, Chrome and the in-app browser the selected account can use.
 */

const problemWords: Record<CodexToolSourceProblem, string> = {
  missing_folder: "The Codex tool folder doesn't exist",
  missing_config: "The Codex tool folder has no config.toml",
  unreadable_config: "ace can't read config.toml in the Codex tool folder",
  too_large_config: "config.toml in the Codex tool folder is over 1 MB",
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
  /** `table.key` names of source entries Codex couldn't be given; never values. */
  skipped: string[];
  /** Why the source added nothing, when it should have. */
  problem?: string;
}

const tablesOf = (source: CodexToolSource) => (source.ok ? source.tables : emptyCodexToolTables);

/**
 * What a Codex launch from `homeDir` adds: nothing when that home is the tool source itself.
 * `home` is that account home's own config: its own `enabled` choices stay, and the source's
 * MCP servers run with the account's Codex home, not the source's.
 */
export function codexToolLaunch(
  source: CodexToolSource,
  homeDir: string,
  home: CodexToolSource,
): CodexToolLaunch {
  if (sameFolder(source.dir, homeDir)) return { args: [], entries: [], skipped: [] };
  if (!source.ok)
    return { args: [], entries: [], skipped: [], problem: problemWords[source.problem] };
  const tables = relocateCodexHome(source.tables, source.dir, homeDir);
  return {
    args: codexToolOverrides(tables, tablesOf(home)),
    entries: codexToolEntryNames(tables),
    skipped: [...source.skipped],
  };
}

/**
 * The tables a Codex launch from `homeDir` ends up with: the account home's own config with
 * the source merged in field by field, the account's own `enabled` kept, as Codex merges the
 * overrides.
 */
export function effectiveCodexTools(
  source: CodexToolSource,
  homeDir: string,
  home: CodexToolSource,
): CodexToolTables {
  if (sameFolder(source.dir, homeDir)) return tablesOf(source);
  return mergeCodexToolTables(tablesOf(source), tablesOf(home));
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
  const host = hostProblem(facts);
  const status: NativeToolStatus[] = [];
  for (const { id, label, plugin } of tools) {
    if (!pluginOn(facts.tables, plugin))
      status.push({
        id,
        label,
        state: "unavailable",
        reason: facts.sourceProblem ?? "Not turned on in Codex",
      });
    else if (id === "browser" && !facts.inAppBrowserPipe)
      status.push({
        id,
        label,
        state: "unavailable",
        reason: "Needs the ChatGPT app; Chrome and ace's browser still work",
      });
    else status.push(host ? { id, label, ...host } : { id, label, state: "ready" });
  }
  return status;
}

/** The tool source row for Settings; names entries Codex couldn't be given, never values. */
export function codexToolSourceStatus(source: CodexToolSource): NativeToolSource {
  const reason =
    toolSourceProblem(source) ??
    (source.ok && source.skipped.length
      ? `Left out, Codex can't take these names: ${source.skipped.join(", ")}`.slice(0, 512)
      : undefined);
  return { path: source.dir, usable: source.ok, ...(reason ? { reason } : {}) };
}
