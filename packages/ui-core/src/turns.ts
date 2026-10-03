import type { ThreadReader } from "@ace/client";
import type { FileChange, Item } from "@ace/protocol";
import { countChanges, diffTexts, fold, parseUnifiedDiff, type DiffRow } from "./diff.ts";

type ToolItem = Extract<Item, { type: "tool_call" }>;
/** One turn of the thread's main agent and every file change made while it ran. */
export interface Turn {
  /** The root agent's run id. */
  id: string;
  /** 1-based among the root turns in the loaded history. */
  number: number;
  edits: readonly ToolItem[];
}

const failed = new Set(["failed", "declined", "cancelled"]);
const changesOf = (item: Item): readonly FileChange[] =>
  item.type === "tool_call" && "changes" in item.call.detail && !failed.has(item.call.status)
    ? item.call.detail.changes
    : [];

/**
 * Group file changes by the root turn they belong to. A subagent's edits count toward the
 * root turn that spawned it (following `spawnedBy`), so "Turn 2" shows everything turn 2 set
 * in motion. Pure over the reader.
 */
export function collectTurns(
  reader: Pick<ThreadReader, "order" | "item" | "run" | "agent" | "thread">,
): Turn[] {
  const rootAgent = reader.thread?.rootAgentId;
  const turns = new Map<string, ToolItem[]>();
  const rootRun = (runId: string | undefined, depth = 0): string | undefined => {
    const run = runId ? reader.run(runId) : undefined;
    if (!run || depth > 16) return undefined;
    if (run.agentId === rootAgent) return run.id;
    const spawn = reader.agent(run.agentId)?.spawnedBy;
    return rootRun(spawn ? reader.item(spawn)?.runId : undefined, depth + 1);
  };
  for (const id of reader.order) {
    const item = reader.item(id);
    if (!item) continue;
    const turn = rootRun(item.runId);
    if (!turn) continue;
    let edits = turns.get(turn);
    if (!edits) turns.set(turn, (edits = []));
    if (item.type === "tool_call" && changesOf(item).length) edits.push(item);
  }
  return [...turns].map(([id, edits], index) => ({ id, number: index + 1, edits }));
}

export function turnsEqual(a: readonly Turn[], b: readonly Turn[]): boolean {
  return (
    a.length === b.length &&
    a.every((turn, index) => {
      const other = b[index];
      return (
        other?.id === turn.id &&
        other.edits.length === turn.edits.length &&
        other.edits.every((item, i) => item === turn.edits[i])
      );
    })
  );
}

export interface FileDiff {
  path: string;
  movedFrom?: string | undefined;
  status: "added" | "modified" | "deleted" | "moved";
  rows: DiffRow[];
  additions: number;
  deletions: number;
}

/** The changes one path received, in order, keyed for caching its diff. */
export interface FileChanges {
  path: string;
  changes: readonly FileChange[];
}

/** File changes grouped by path, in first-touched order. Cheap: no diffing. */
export function groupFileChanges(items: readonly ToolItem[]): FileChanges[] {
  const byPath = new Map<string, FileChange[]>();
  for (const item of items)
    for (const change of changesOf(item)) {
      const path = change.kind === "move" && change.movePath ? change.movePath : change.path;
      const list = byPath.get(path) ?? [];
      list.push(change);
      byPath.set(path, list);
    }
  return [...byPath].map(([path, changes]) => ({ path, changes }));
}

/**
 * The cache key of a file's diff: the content of every change (like old and new blob ids) plus
 * the diff options. Equal keys give equal diffs, so a diff is computed once per content.
 */
export function fileDiffKey(file: FileChanges, hash: (text: string) => string): string {
  const parts = [`v1|ctx3|${file.path}`];
  for (const change of file.changes)
    parts.push(
      [
        change.kind,
        change.path,
        change.movePath ?? "",
        change.oldText === undefined || change.oldText === null ? "-" : hash(change.oldText),
        change.newText === undefined ? "-" : hash(change.newText),
        change.diff === undefined ? "-" : hash(change.diff),
      ].join(":"),
    );
  return hash(parts.join("|"));
}

/** What happened to a file across its changes: added, deleted, moved or modified. Cheap. */
export function fileStatus(changes: readonly FileChange[]): FileDiff["status"] {
  if (changes[0]?.kind === "add") return "added";
  if (changes.at(-1)?.kind === "delete") return "deleted";
  return changes.some((change) => change.kind === "move") ? "moved" : "modified";
}

/**
 * One file's diff. Successive full-text edits compose into one before/after diff; provider
 * patches are shown hunk by hunk. Linear to quadratic in the file's size: run it off the main
 * thread (the web app's diff worker).
 */
export function diffFile(file: FileChanges): FileDiff {
  const { path, changes } = file;
  const rows = rowsFor(changes);
  const status = fileStatus(changes);
  const { additions, deletions } = countChanges(rows);
  const diff: FileDiff = { path, status, rows, additions, deletions };
  const moved = changes.find((change) => change.kind === "move");
  if (moved) diff.movedFrom = moved.path;
  return diff;
}

/** One diff per path, in first-touched order (groupFileChanges, then diffFile). */
export function fileDiffs(items: readonly ToolItem[]): FileDiff[] {
  return groupFileChanges(items).map(diffFile);
}

function rowsFor(changes: readonly FileChange[]): DiffRow[] {
  const texts = changes.every((change) => change.newText !== undefined || change.kind === "delete");
  const chained = changes.every(
    (change, index) => index === 0 || change.oldText === changes[index - 1]?.newText,
  );
  if (texts && chained) {
    const before = changes[0]?.oldText ?? "";
    const last = changes.at(-1);
    const after = last?.kind === "delete" ? "" : (last?.newText ?? "");
    return fold(diffTexts(before, after));
  }
  return changes.flatMap((change, index): DiffRow[] => {
    const rows = change.diff
      ? parseUnifiedDiff(change.diff)
      : change.newText !== undefined || change.oldText
        ? fold(diffTexts(change.oldText ?? "", change.newText ?? ""))
        : [];
    return index > 0 && rows.length ? [{ kind: "fold", count: null }, ...rows] : rows;
  });
}
