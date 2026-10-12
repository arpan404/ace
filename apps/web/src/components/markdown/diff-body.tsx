import type { ReactNode } from "react";
import { LongRows } from "@/components/virtual-rows.tsx";
import type { FenceDiff, FenceDiffLine } from "./diff-fence.ts";

/**
 * Added and removed lines are tinted across the block's width, with a bar at their edge; they
 * are `<ins>` and `<del>` too, so assistive tech says which is which.
 */
const tint: Record<FenceDiffLine["kind"], string> = {
  add: "bg-status-done/10 shadow-[inset_2px_0_0_var(--status-done)]",
  del: "bg-status-failed/10 shadow-[inset_2px_0_0_var(--status-failed)]",
  hunk: "bg-accent/60 text-muted-foreground",
  meta: "text-subtle-foreground",
  context: "",
};

// On a phone the tint and the +/− carry the diff; two number columns would take a quarter of it.
const gutter =
  "w-9 shrink-0 pr-2 text-right tabular-nums text-subtle-foreground select-none max-sm:hidden";

function Row(props: { line: FenceDiffLine; numbered: boolean }) {
  const { line } = props;
  return (
    <div className={`flex min-h-[1.55em] ${tint[line.kind]}`}>
      {props.numbered && (
        <>
          <span aria-hidden className={gutter}>
            {line.old ?? ""}
          </span>
          <span aria-hidden className={gutter}>
            {line.new ?? ""}
          </span>
        </>
      )}
      <code className="pr-3 pl-3 whitespace-pre">
        {line.kind === "add" ? (
          <ins className="no-underline">{line.text}</ins>
        ) : line.kind === "del" ? (
          <del className="no-underline">{line.text}</del>
        ) : (
          line.text || "\u00a0"
        )}
      </code>
    </div>
  );
}

/**
 * A ```diff fence as a unified diff: every line as written, added and removed ones tinted, old
 * and new line numbers where hunk headers give them. Long diffs mount the rows in view only.
 */
export function DiffBody(props: { diff: FenceDiff; tail?: ReactNode }) {
  const { diff } = props;
  const long = diff.lines.length > 400;
  return (
    <div
      {...(long ? { role: "region", "aria-label": "Scrollable code", tabIndex: 0 } : {})}
      className={`overflow-x-auto pt-1 pb-2 font-mono text-[12.5px] leading-[1.55] text-foreground ${long ? "max-h-80 overflow-y-auto" : ""}`}
    >
      <div className="inline-block min-w-full">
        <LongRows
          virtualAbove={400}
          items={diff.lines}
          rowKey={(_, index) => String(index)}
          estimate={19}
          overscan={8}
          render={(line) => <Row line={line} numbered={diff.numbered} />}
        />
        {props.tail}
      </div>
    </div>
  );
}
