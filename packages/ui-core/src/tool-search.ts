import type { ToolCall } from "@ace/protocol";
import { aceToolWords, type AceToolView } from "./ace-tools.ts";
import { say, type ToolWords } from "./ace-tool-specs.ts";

/*
 * An agent searching or loading its own deferred tools (Claude's `ToolSearch`) as a row:
 * "Loaded the ace tool to link a PR", "Loaded 3 tools  Read, Edit, Neon › run_sql",
 * "Searched tools for `notebook jupyter`". Never the raw `select:mcp__ace__…` query. Pure.
 */

/** A search of the agent's own tools rather than of the code. */
export function isToolSearch(call: Pick<ToolCall, "detail" | "title">): boolean {
  if (call.detail.kind !== "search") return false;
  // Transcripts recorded before the adapter marked the scope still carry Claude's tool name.
  return call.detail.scope === "tools" || call.title === "ToolSearch";
}

export interface ToolSearchRow {
  words: ToolWords;
  /** Set when every tool it loaded is ace's own, so the row carries ace's mark. */
  ace?: AceToolView | undefined;
  /** It loaded named tools (`select:`), rather than searching by keywords. */
  loaded: boolean;
}

/** The names a `select:A,B` query loads; undefined for a keyword search. */
function selected(query: string): string[] | undefined {
  const match = /^select:(.*)$/is.exec(query.trim());
  if (!match) return undefined;
  return (match[1] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

const isAce = (name: string) => name.startsWith("mcp__ace__");

/** What an ace tool does, as the rest of a sentence: "link a PR", "read this thread". */
function aceDoes(name: string): string {
  const words = aceToolWords("ace", name, {});
  const phrase = words ? `${words.awaiting}${words.target ? ` ${words.target}` : ""}` : name;
  return phrase.charAt(0).toLowerCase() + phrase.slice(1);
}

/** `mcp__Neon__run_sql` as "Neon › run_sql"; a built-in tool keeps its name. */
function toolLabel(name: string): string {
  if (!name.startsWith("mcp__")) return name;
  const [server = "", ...tool] = name.slice("mcp__".length).split("__");
  return tool.length ? `${server} › ${tool.join("__")}` : server;
}

const loadedVerbs = ["Loaded", "Loading", "Load"] as const;

function aceRow(names: readonly string[]): ToolSearchRow {
  const [first = "", second = ""] = names;
  const words =
    names.length === 1
      ? say(loadedVerbs, ` the ace tool to ${aceDoes(first)}`)
      : names.length === 2
        ? say(loadedVerbs, ` ace tools to ${aceDoes(first)} and ${aceDoes(second)}`)
        : say(loadedVerbs, ` ${names.length} ace tools`);
  return {
    words,
    loaded: true,
    ace: {
      family: "ace",
      mark: { kind: "glyph", glyph: "ace" },
      words,
      images: [],
      tool: `ToolSearch · ${names.join(", ")}`,
    },
  };
}

/** How a tool search reads, from its query. */
export function toolSearchRow(query: string): ToolSearchRow {
  const names = selected(query);
  if (!names) {
    const keywords = query.trim().replace(/^\+/, "").trim();
    return {
      words: say(
        ["Searched tools", "Searching tools", "Search tools"],
        keywords ? " for" : "",
        keywords || undefined,
      ),
      loaded: false,
    };
  }
  if (names.length > 0 && names.every(isAce)) return aceRow(names);
  if (names.length === 0) return { words: say(loadedVerbs, " tools"), loaded: true };
  const rest = names.length === 1 ? " the tool" : ` ${names.length} tools`;
  return { words: say(loadedVerbs, rest, names.map(toolLabel).join(", ")), loaded: true };
}
