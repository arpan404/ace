import type { ThreadDetails } from "@ace/protocol";
import { changeTreeRows, type DiffScope } from "@ace/ui-core";
import { changesNextStep, changesSummary, mergeMethods } from "@ace/ui-core/mobile";
import type { Preview } from "./agents.ts";
import type { ScopeFile } from "./changes-diffs.ts";
import type { DiffLayout } from "./changes-kept.ts";
import type { ChangesScope, Reads } from "./changes-scope.ts";

/*
 * The Changes sheet's list patches: `changes.summary` (the scope's files with their counts and
 * viewed marks, the scopes on offer, what is open, the next git step) and `changes.tree` (the
 * same files as folder rows). Built when the pump reads them.
 */

/** Files one summary lists; the rest are counted in `hidden`. */
const listed = 200;

export interface SummaryInput {
  threadId: string;
  epoch: number;
  preview: Preview;
  details: ThreadDetails | undefined;
  reads: Reads | undefined;
  state: "loading" | "ready" | "error";
  message: string;
  scope: ChangesScope;
  /** A turn scope's files; undefined for the working tree. */
  turnFiles: ScopeFile[] | undefined;
  viewed: (path: string) => boolean;
  open: readonly string[];
  openLimit: number;
  layout: DiffLayout;
  busy: boolean;
  /** Whether the scope takes review comments, and why not. */
  review: { allowed: boolean; reason: string };
}

function turnSummary(files: readonly ScopeFile[]) {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return {
    files: files.slice(0, listed),
    hidden: Math.max(0, files.length - listed),
    partial: files.some((file) => !file.counted),
    totals: { files: files.length, additions, deletions },
  };
}

export function summaryPatch(input: SummaryInput): Record<string, unknown> {
  const { reads, preview, scope } = input;
  const checkout = reads ? changesSummary(reads.files, reads.truncated, listed) : undefined;
  const shown = input.turnFiles
    ? turnSummary(input.turnFiles)
    : checkout && {
        ...checkout,
        files: checkout.files.map((file) => ({ ...file, counted: true })),
      };
  // The next step is the checkout's, whatever scope the list shows.
  const step = changesNextStep(input.details, reads?.pr, checkout?.totals);
  const resolved = scope.resolved;
  return {
    type: "changes.summary",
    threadId: input.threadId,
    epoch: input.epoch,
    state: input.state,
    message: input.message,
    scope: {
      id: resolved.scope,
      label: scope.label(),
      turn: resolved.turn?.number ?? null,
      workingTree: scope.workingTree,
    },
    scopes: scope.options(),
    files: (shown?.files ?? []).map((file) => ({
      path: preview(file.path, 1024),
      from: file.from === null ? null : preview(file.from, 1024),
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      binary: file.binary,
      counted: file.counted,
      viewed: input.viewed(file.path),
      open: input.open.includes(file.path),
    })),
    hidden: shown?.hidden ?? 0,
    partial: shown?.partial ?? false,
    totals: shown?.totals ?? { files: 0, additions: 0, deletions: 0 },
    patchTruncated: scope.workingTree ? (reads?.patchTruncated ?? false) : false,
    open: input.open.map((path) => preview(path, 1024)),
    openLimit: input.openLimit,
    layout: input.layout,
    review: input.review,
    branch: preview(input.details?.branch ?? "", 256),
    step: {
      ...step,
      label: preview(step.label, 128),
      detail: preview(step.detail, 512),
      blocked: step.blocked === null ? null : preview(step.blocked, 512),
      pr: step.pr && { ...step.pr, title: step.pr.title && preview(step.pr.title, 256) },
    },
    busy: input.busy,
    // Every way the forge merges; the phone remembers the last one picked.
    methods: mergeMethods.map((each) => ({ method: each.method, label: each.label })),
  };
}

/** The listed files as a folder tree, every folder open; the phone collapses folders itself. */
export function treePatch(
  threadId: string,
  epoch: number,
  preview: Preview,
  scope: DiffScope,
  files: readonly { path: string; additions: number; deletions: number }[],
): Record<string, unknown> {
  return {
    type: "changes.tree",
    threadId,
    epoch,
    scope,
    rows: changeTreeRows(files).map((row) =>
      row.kind === "folder"
        ? {
            kind: "folder",
            key: preview(row.key, 1024),
            name: preview(row.name, 512),
            depth: row.depth,
            additions: row.additions,
            deletions: row.deletions,
            files: row.files,
          }
        : {
            kind: "file",
            key: preview(row.key, 1024),
            name: preview(row.name, 512),
            depth: row.depth,
            additions: row.additions,
            deletions: row.deletions,
            index: row.index,
          },
    ),
  };
}
