import type { GitStatusSectionEntry, WorkspaceActionResult } from "@ace/protocol";

export type GitStatusReply = Extract<WorkspaceActionResult["result"], { kind: "gitStatus" }>;
export type GitDiffReply = Extract<WorkspaceActionResult["result"], { kind: "gitDiff" }>;

export type SourceControlSection = "conflicts" | "staged" | "changes";

export type StatusLetter = "M" | "A" | "D" | "R" | "U" | "C";

export interface SourceControlItem {
  readonly path: string;
  readonly oldPath?: string | undefined;
  readonly letter: StatusLetter;
  readonly statusLabel: string;
  readonly colorClass: string;
  readonly untracked: boolean;
  readonly section: SourceControlSection;
}

export interface SourceControlSections {
  readonly conflicts: readonly SourceControlItem[];
  readonly staged: readonly SourceControlItem[];
  readonly changes: readonly SourceControlItem[];
  /** Unique changed file paths across conflicts, staged and unstaged/untracked changes. */
  readonly totalCount: number;
}

export interface StatusMeta {
  readonly letter: StatusLetter;
  readonly label: string;
  readonly colorClass: string;
}

const statusTable: Record<StatusLetter, StatusMeta> = {
  M: { letter: "M", label: "Modified", colorClass: "text-status-needs-you" },
  A: { letter: "A", label: "Added", colorClass: "text-status-done" },
  D: { letter: "D", label: "Deleted", colorClass: "text-status-failed" },
  R: { letter: "R", label: "Renamed", colorClass: "text-status-working" },
  U: { letter: "U", label: "Untracked", colorClass: "text-status-done" },
  C: { letter: "C", label: "Conflict", colorClass: "text-status-failed" },
};

/** Status letter, human label, and semantic color token for one entry in a section. */
export function statusMeta(
  entry: GitStatusSectionEntry,
  section: SourceControlSection,
): StatusMeta {
  if (section === "conflicts" || entry.status === "conflicted") return statusTable.C;
  switch (entry.status) {
    case "added":
      return statusTable.A;
    case "deleted":
      return statusTable.D;
    case "renamed":
      return statusTable.R;
    case "untracked":
      return statusTable.U;
    case "modified":
      return statusTable.M;
  }
}

function toItem(entry: GitStatusSectionEntry, section: SourceControlSection): SourceControlItem {
  const meta = statusMeta(entry, section);
  return {
    path: entry.path,
    oldPath: entry.from,
    letter: meta.letter,
    statusLabel: meta.label,
    colorClass: meta.colorClass,
    untracked: section === "changes" && entry.status === "untracked",
    section,
  };
}

const comparePaths = (a: { path: string }, b: { path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/**
 * Partition `git.status` into the three sections: Merge conflicts, Staged changes, and Changes
 * (unstaged + untracked sorted together by path).
 */
export function buildSections(status: GitStatusReply | undefined): SourceControlSections {
  if (!status) return { conflicts: [], staged: [], changes: [], totalCount: 0 };
  const conflicts = (status.conflicted ?? [])
    .map((entry) => toItem(entry, "conflicts"))
    .toSorted(comparePaths);
  const staged = (status.staged ?? [])
    .map((entry) => toItem(entry, "staged"))
    .toSorted(comparePaths);
  const changes = [...(status.unstaged ?? []), ...(status.untracked ?? [])]
    .map((entry) => toItem(entry, "changes"))
    .toSorted(comparePaths);

  const unique = new Set<string>();
  for (const item of conflicts) unique.add(item.path);
  for (const item of staged) unique.add(item.path);
  for (const item of changes) unique.add(item.path);
  // Fallback when an older daemon omits the sectioned arrays.
  if (unique.size === 0 && status.files.length > 0) {
    for (const file of status.files) unique.add(file.path);
  }
  return { conflicts, staged, changes, totalCount: unique.size };
}

/** Split a repo-relative path into its base file name and parent folder ("" at root). */
export function splitPath(path: string): { name: string; folder: string } {
  const slash = path.lastIndexOf("/");
  if (slash === -1) return { name: path, folder: "" };
  return { name: path.slice(slash + 1), folder: path.slice(0, slash) };
}

export interface SelectionState {
  readonly selected: ReadonlySet<string>;
  readonly anchor: string | undefined;
}

export const emptySelection: SelectionState = { selected: new Set(), anchor: undefined };

/**
 * Update a section's multi-selection on click:
 * - Plain click selects only the clicked path and sets anchor.
 * - ⌘ / Ctrl click toggles the clicked path and updates anchor.
 * - ⇧ click selects the contiguous range from anchor to the clicked path.
 */
export function selectRow(
  current: SelectionState,
  orderedPaths: readonly string[],
  clickedPath: string,
  modifiers: { meta: boolean; ctrl: boolean; shift: boolean },
): SelectionState {
  if (modifiers.shift && current.anchor !== undefined) {
    const start = orderedPaths.indexOf(current.anchor);
    const end = orderedPaths.indexOf(clickedPath);
    if (start !== -1 && end !== -1) {
      const low = Math.min(start, end);
      const high = Math.max(start, end);
      const next = new Set(modifiers.meta || modifiers.ctrl ? current.selected : []);
      for (let i = low; i <= high; i++) {
        const path = orderedPaths[i];
        if (path !== undefined) next.add(path);
      }
      return { selected: next, anchor: current.anchor };
    }
  }
  if (modifiers.meta || modifiers.ctrl) {
    const next = new Set(current.selected);
    if (next.has(clickedPath)) next.delete(clickedPath);
    else next.add(clickedPath);
    return { selected: next, anchor: clickedPath };
  }
  return { selected: new Set([clickedPath]), anchor: clickedPath };
}

/** Drop paths that disappeared after a status refresh while preserving the remaining selection. */
export function pruneSelection(
  current: SelectionState,
  orderedPaths: readonly string[],
): SelectionState {
  if (current.selected.size === 0 && current.anchor === undefined) return current;
  const present = new Set(orderedPaths);
  const next = new Set([...current.selected].filter((path) => present.has(path)));
  const anchor = current.anchor && present.has(current.anchor) ? current.anchor : undefined;
  if (next.size === current.selected.size && anchor === current.anchor) return current;
  return { selected: next, anchor };
}

/**
 * Paths a row action targets: if the clicked row is part of a multi-selection in the section,
 * operate on the full selection in display order; otherwise just the clicked row.
 */
export function targetPaths(
  orderedPaths: readonly string[],
  selected: ReadonlySet<string>,
  clickedPath: string,
): readonly string[] {
  if (selected.size > 1 && selected.has(clickedPath)) {
    return orderedPaths.filter((path) => selected.has(path));
  }
  return [clickedPath];
}

/** Whether a commit can be triggered given the current message and working tree state. */
export function canCommitChanges(options: {
  message: string;
  stagedCount: number;
  changesCount: number;
  conflictsCount: number;
}): boolean {
  if (options.message.trim().length === 0) return false;
  if (options.conflictsCount > 0) return false;
  return options.stagedCount > 0 || options.changesCount > 0;
}
