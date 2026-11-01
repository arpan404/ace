import type { WorkspaceScript } from "@ace/protocol";
import { fuzzyPositions } from "./checkout-files.ts";

type Choice = Pick<WorkspaceScript, "name" | "source">;

/** How well `name` answers `query`: a prefix, then a substring, then letters in order. */
function matchRank(name: string, query: string): number | undefined {
  const lower = name.toLowerCase();
  if (lower.startsWith(query)) return 0;
  if (lower.includes(query)) return 1;
  return fuzzyPositions(query, name) ? 2 : undefined;
}

/**
 * The scripts "Run a script" lists for `query`: the project's own script files (a Procfile,
 * Makefile or justfile) before package.json's, each in the daemon's order. A query keeps only
 * names it matches, closest matches first.
 */
export function scriptChoices<Script extends Choice>(
  scripts: readonly Script[],
  query: string,
): Script[] {
  const needle = query.trim().toLowerCase();
  return scripts
    .map((script, index) => ({
      script,
      index,
      saved: script.source === "package.json" ? 1 : 0,
      rank: needle ? matchRank(script.name, needle) : 0,
    }))
    .filter((entry) => entry.rank !== undefined)
    .toSorted((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || a.saved - b.saved || a.index - b.index)
    .map((entry) => entry.script);
}
