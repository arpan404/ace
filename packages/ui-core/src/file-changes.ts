import type { FileChange, Item } from "@ace/protocol";
import { diffTexts } from "./diff.ts";

export interface PatchLine {
  kind: "add" | "del" | "context" | "hunk";
  text: string;
}

/** Lines of a unified diff, without file headers. */
export function patchLines(diff: string): PatchLine[] {
  const lines: PatchLine[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ")) continue;
    if (line.startsWith("@@")) lines.push({ kind: "hunk", text: line });
    else if (line.startsWith("+")) lines.push({ kind: "add", text: line.slice(1) });
    else if (line.startsWith("-")) lines.push({ kind: "del", text: line.slice(1) });
    else if (line.length || lines.length) lines.push({ kind: "context", text: line.slice(1) });
  }
  return lines;
}

const lineCount = (text: string | null | undefined) =>
  text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;

export interface DiffStat {
  added: number;
  removed: number;
}

/** Lines added and removed by one change, from its diff or else by diffing its before and after text. */
export function changeStat(change: FileChange): DiffStat {
  if (change.diff) {
    let added = 0;
    let removed = 0;
    for (const line of patchLines(change.diff)) {
      if (line.kind === "add") added++;
      else if (line.kind === "del") removed++;
    }
    return { added, removed };
  }
  if (change.kind === "delete") return { added: 0, removed: lineCount(change.oldText) };
  // Full before and after text: count the lines that differ, exactly as the diff view shows
  // them, not the size of the whole file.
  if (change.oldText && change.newText) {
    let added = 0;
    let removed = 0;
    for (const line of diffTexts(change.oldText, change.newText)) {
      if (line.kind === "add") added++;
      else if (line.kind === "del") removed++;
    }
    return { added, removed };
  }
  return { added: lineCount(change.newText), removed: lineCount(change.oldText) };
}

/** File changes made by an edit-like tool call, or none. */
export function fileChanges(item: Item | undefined): readonly FileChange[] {
  if (item?.type !== "tool_call") return [];
  const detail = item.call.detail;
  return "changes" in detail ? detail.changes : [];
}

/** Per-file totals across calls, in first-touched order. Later edits to a file add up. */
export function summarizeChanges(
  items: readonly (Item | undefined)[],
): { path: string; stat: DiffStat }[] {
  const files = new Map<string, DiffStat>();
  for (const item of items)
    for (const change of fileChanges(item)) {
      const stat = changeStat(change);
      const path = change.movePath ?? change.path;
      const previous = files.get(path) ?? { added: 0, removed: 0 };
      files.set(path, {
        added: previous.added + stat.added,
        removed: previous.removed + stat.removed,
      });
    }
  return [...files].map(([path, stat]) => ({ path, stat }));
}
