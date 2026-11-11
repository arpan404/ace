import { useState } from "react";
import { threadCode, type ThreadCodeRow } from "@ace/ui-core";
import type { ForgePrStatus } from "@ace/protocol";
import { cn } from "@/lib/cn.ts";

type ReviewThread = ForgePrStatus["reviewThreads"][number];
/** One line to draw; `key` is unique among the rows. */
export type CodeRow = Pick<ThreadCodeRow, "kind" | "left" | "right" | "text" | "commented"> & {
  key: string;
};
/** Lines shown at first; the rest of the kept hunk opens on request. */
const firstLines = 4;

/** The last few rows, and a "Show N lines above" button that opens the rest. */
function useFirstLines(all: readonly CodeRow[], className?: string) {
  const [open, setOpen] = useState(false);
  const hidden = Math.max(0, all.length - firstLines);
  const rows = open ? all : all.slice(-firstLines);
  const more = hidden > 0 && !open && (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className={cn(
        "text-xs text-subtle-foreground hover:text-muted-foreground focus-ring",
        className,
      )}
    >
      {hidden === 1 ? "Show 1 line above" : `Show ${hidden} lines above`}
    </button>
  );
  return { rows, more };
}

/** Code rows with their line numbers; added and removed lines keep the diff's colours. */
function CodeLines(props: { rows: readonly CodeRow[]; className?: string | undefined }) {
  return (
    <pre className={cn("overflow-x-auto font-mono text-xs leading-5", props.className)}>
      {props.rows.map((row) => (
        <div
          key={row.key}
          className={cn(
            "flex min-w-max gap-3 pr-3",
            row.kind === "+" && "bg-diff-add",
            row.kind === "-" && "bg-diff-del",
            row.commented ? "text-foreground" : "text-subtle-foreground",
          )}
        >
          <span aria-hidden className="w-10 shrink-0 text-right tabular-nums opacity-70">
            {row.right ?? row.left ?? ""}
          </span>
          <span className="whitespace-pre">{row.text || " "}</span>
        </div>
      ))}
    </pre>
  );
}

/**
 * A few lines of code a conversation or draft was written on, as it was then. The lines it
 * is on are brighter; added and removed lines keep the diff's colours.
 */
export function PrEarlierCode(props: {
  rows: readonly CodeRow[];
  label: string;
  className?: string | undefined;
}) {
  const { rows, more } = useFirstLines(props.rows);
  if (!rows.length) return null;
  return (
    <figure aria-label={props.label} className={cn("min-w-0 space-y-1", props.className)}>
      {more}
      <CodeLines rows={rows} className="border-l border-border-soft" />
    </figure>
  );
}

const threadRows = (thread: ReviewThread): CodeRow[] =>
  threadCode(thread, 12).map((row) =>
    Object.assign(row, { key: `${row.kind}${row.left ?? ""}:${row.right ?? ""}` }),
  );
const threadCodeLabel = (thread: ReviewThread) => {
  const commit = thread.originalCommit?.slice(0, 7);
  return commit ? `Code at ${commit}` : "Code this conversation is on";
};

/** The code a conversation was written on, from GitHub's hunk; nothing when it sent none. */
export function PrThreadEarlierCode(props: { thread: ReviewThread; className?: string }) {
  return (
    <PrEarlierCode
      rows={threadRows(props.thread)}
      label={threadCodeLabel(props.thread)}
      className={props.className}
    />
  );
}

/**
 * The code a conversation was written on, framed: its file in a bar with the line it is on,
 * then the hunk's last lines. Just the file bar when GitHub sent no hunk.
 */
export function PrThreadHunk(props: { thread: ReviewThread; className?: string | undefined }) {
  const { thread } = props;
  const { rows, more } = useFirstLines(threadRows(thread), "px-3 py-1");
  const line = thread.line ?? thread.originalLine ?? null;
  const start = thread.startLine ?? thread.originalStartLine ?? null;
  return (
    <figure
      aria-label={threadCodeLabel(thread)}
      className={cn("min-w-0 overflow-hidden rounded-md border border-border", props.className)}
    >
      <figcaption className="flex min-w-0 items-center gap-3 bg-surface-1 px-3 py-1.5 text-xs">
        <span dir="rtl" className="min-w-0 flex-1 truncate text-left">
          <bdi dir="ltr" className="font-mono text-foreground">
            {thread.file}
          </bdi>
        </span>
        {line !== null && (
          <span className="shrink-0 text-subtle-foreground tabular-nums">
            {start !== null && start < line ? `Lines ${start}–${line}` : `Line ${line}`}
          </span>
        )}
      </figcaption>
      {rows.length > 0 && (
        <div className="border-t border-border bg-background">
          {more}
          <CodeLines rows={rows} className="py-0.5" />
        </div>
      )}
    </figure>
  );
}
