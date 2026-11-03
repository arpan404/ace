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

/**
 * A few lines of code a conversation or draft was written on, as it was then. The lines it
 * is on are brighter; added and removed lines keep the diff's colours.
 */
export function PrEarlierCode(props: {
  rows: readonly CodeRow[];
  label: string;
  className?: string | undefined;
}) {
  const [all, setAll] = useState(false);
  const hidden = Math.max(0, props.rows.length - firstLines);
  const rows = all ? props.rows : props.rows.slice(-firstLines);
  if (!rows.length) return null;
  return (
    <figure aria-label={props.label} className={cn("min-w-0 space-y-1", props.className)}>
      {hidden > 0 && !all && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="text-xs text-subtle-foreground hover:text-muted-foreground focus-ring"
        >
          {hidden === 1 ? "Show 1 line above" : `Show ${hidden} lines above`}
        </button>
      )}
      <pre className="overflow-x-auto border-l border-border-soft font-mono text-xs leading-5">
        {rows.map((row) => (
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
    </figure>
  );
}

/** The code a conversation was written on, from GitHub's hunk; nothing when it sent none. */
export function PrThreadEarlierCode(props: { thread: ReviewThread; className?: string }) {
  const rows = threadCode(props.thread, 12).map((row) =>
    Object.assign(row, { key: `${row.kind}${row.left ?? ""}:${row.right ?? ""}` }),
  );
  const commit = props.thread.originalCommit?.slice(0, 7);
  return (
    <PrEarlierCode
      rows={rows}
      label={commit ? `Code at ${commit}` : "Code this conversation is on"}
      className={props.className}
    />
  );
}
