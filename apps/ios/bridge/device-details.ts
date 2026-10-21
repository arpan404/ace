import type { ScreenUINode, ScreenUITreeResult } from "@ace/protocol";
import { filterLines, logLevel, shortRefs, type RefNode } from "@ace/ui-core/devices";

/*
 * A device's logs and UI tree as the phone's sheets show them, by the web's rules: each log
 * line's level and the filter, and the tree's `@eN` refs as agents see them, flattened with
 * their depth. Pure.
 */

/** Lines a device's log tail keeps, as on the web. */
export const logKeep = 500;
/** Lines one patch carries: the newest that match the filter. */
const logShown = 300;
const lineLimit = 1024;

export interface LogTail {
  lines: string[];
  dropped: number;
}

/** The tail after a batch arrives: newest last, at most `logKeep`. */
export function appendLogs(tail: LogTail, lines: readonly string[], dropped: number): LogTail {
  const next = [...tail.lines, ...lines];
  return { lines: next.slice(-logKeep), dropped: tail.dropped + dropped };
}

export function logView(tail: LogTail, filter: string) {
  const shown = filterLines(tail.lines, filter);
  return {
    total: tail.lines.length,
    matches: shown.length,
    dropped: tail.dropped,
    lines: shown.slice(-logShown).map((line) => ({
      text: line.length > lineLimit ? `${line.slice(0, lineLimit)}…` : line,
      level: logLevel(line),
    })),
  };
}

export interface TreeRow {
  /** Stable within one read. */
  id: string;
  depth: number;
  /** `e7` on elements an agent can act on; empty on the rest. */
  ref: string;
  role: string;
  name: string;
}

/** The tree agents read, flattened in reading order with each element's depth. */
export function treeRows(result: Pick<ScreenUITreeResult, "nodes" | "truncated">): {
  rows: TreeRow[];
  truncated: boolean;
} {
  const rows: TreeRow[] = [];
  const visit = (entry: RefNode, depth: number, path: string) => {
    const node: ScreenUINode = entry.node;
    rows.push({
      id: path,
      depth,
      ref: entry.ref ?? "",
      role: node.role,
      name: node.name,
    });
    entry.children.forEach((child, index) => visit(child, depth + 1, `${path}.${index}`));
  };
  shortRefs(result.nodes).forEach((entry, index) => visit(entry, 0, String(index)));
  return { rows, truncated: result.truncated };
}
