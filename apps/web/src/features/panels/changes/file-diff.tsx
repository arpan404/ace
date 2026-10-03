import { CaretDownIcon, CodeIcon, PlusIcon } from "@phosphor-icons/react";
import { cn } from "cn";
import { Fragment, useState } from "react";
import type { ReactNode } from "react";
import { pairRows, type DiffLine, type DiffRow, type SplitRow } from "./diff.ts";
import { DiffStat } from "./diff-stat.tsx";
import type { FileDiff } from "./turns.ts";

export interface LineTarget {
  side: "old" | "new";
  line: number;
}
export const targetOf = (line: DiffLine): LineTarget | undefined =>
  line.kind === "del"
    ? line.old === undefined
      ? undefined
      : { side: "old", line: line.old }
    : line.new === undefined
      ? undefined
      : { side: "new", line: line.new };
const sameTarget = (a: LineTarget | undefined, b: LineTarget | undefined) =>
  !!a && !!b && a.side === b.side && a.line === b.line;

/**
 * One changed file: a sticky header that collapses it, then its lines in unified or split
 * layout. Unchanged runs fold; folds with known lines expand on click. `renderAnnotation` renders
 * the comment UI under a line; `onComment` starts one.
 */
export function FileDiffBlock(props: {
  id?: string;
  file: FileDiff;
  mode: "unified" | "split";
  wrap: boolean;
  highlighted(target: LineTarget): boolean;
  renderAnnotation(target: LineTarget): ReactNode;
  onComment(target: LineTarget): void;
}) {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const { file } = props;
  const slash = file.path.lastIndexOf("/");
  const rows: DiffRow[] = file.rows.flatMap((row, index) =>
    row.kind === "fold" && expanded.has(index) && row.lines ? row.lines : [row],
  );
  const indexOf = new Map(file.rows.map((row, index) => [row, index]));
  const expand = (row: DiffRow) => {
    const index = indexOf.get(row);
    if (index !== undefined) setExpanded((previous) => new Set(previous).add(index));
  };
  return (
    <section id={props.id} aria-label={file.path} className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="sticky top-9 z-[1] flex h-[34px] w-full items-center gap-2 bg-panel px-3.5 text-left font-mono text-[12px] text-muted-foreground hover:text-foreground"
      >
        <CaretDownIcon
          aria-hidden
          size={14}
          className={cn(
            "shrink-0 text-subtle-foreground transition-transform duration-200 ease-spring",
            !open && "-rotate-90",
          )}
        />
        <CodeIcon aria-hidden size={14} className="shrink-0 text-subtle-foreground" />
        <span className="min-w-0 truncate">
          {file.movedFrom && <span>{file.movedFrom} → </span>}
          {file.path.slice(0, slash + 1)}
          <b className="font-medium text-foreground">{file.path.slice(slash + 1)}</b>
        </span>
        {file.status !== "modified" && (
          <span className="shrink-0 font-sans text-xs text-subtle-foreground">{file.status}</span>
        )}
        <DiffStat
          additions={file.additions}
          deletions={file.deletions}
          className="ml-auto text-[12px]"
        />
      </button>
      {open && (
        <div
          className={cn(
            "font-mono text-[12px] leading-5",
            props.wrap ? "whitespace-pre-wrap break-all" : "overflow-x-auto whitespace-pre",
          )}
        >
          {props.mode === "unified" ? (
            <Unified rows={rows} expand={expand} {...props} />
          ) : (
            <Split rows={rows} expand={expand} {...props} />
          )}
        </div>
      )}
    </section>
  );
}

type RowsProps = Parameters<typeof FileDiffBlock>[0] & {
  rows: DiffRow[];
  expand(row: DiffRow): void;
};

/** Data keys for rows: a row's line numbers, plus an occurrence count where patches repeat. */
function keyed<T>(items: readonly T[], base: (item: T) => string): { item: T; key: string }[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const id = base(item);
    const count = seen.get(id) ?? 0;
    seen.set(id, count + 1);
    return { item, key: count ? `${id}#${count}` : id };
  });
}
const lineKey = (row: DiffRow) =>
  row.kind === "fold"
    ? `fold:${row.lines?.[0]?.old ?? row.count ?? ""}`
    : `${row.kind}:${row.old ?? ""}:${row.new ?? ""}`;

function Unified(props: RowsProps) {
  return keyed(props.rows, lineKey).map(({ item: row, key }) => {
    if (row.kind === "fold") return <Fold key={key} row={row} expand={props.expand} />;
    const target = targetOf(row);
    return (
      <Fragment key={key}>
        <div
          className={cn(
            "group/line relative grid min-w-max grid-cols-[44px_44px_minmax(0,1fr)]",
            props.wrap && "min-w-0",
            tone(row),
            target && props.highlighted(target) && commented,
          )}
        >
          <Gutter line={row} value={row.old} />
          <Gutter line={row} value={row.new} />
          <Code line={row} target={target} onComment={props.onComment} />
        </div>
        {target && props.renderAnnotation(target)}
      </Fragment>
    );
  });
}

const pairKey = (pair: SplitRow) =>
  pair.kind === "fold"
    ? lineKey(pair.row)
    : `pair:${pair.left?.old ?? ""}:${pair.right?.new ?? ""}`;

function Split(props: RowsProps) {
  return keyed(pairRows(props.rows), pairKey).map(({ item: pair, key }) => {
    if (pair.kind === "fold") return <Fold key={key} row={pair.row} expand={props.expand} />;
    const sides = [
      { side: "left", line: pair.left, number: pair.left?.old },
      { side: "right", line: pair.right, number: pair.right?.new },
    ] as const;
    const targets = sides
      .map(({ line }) => line && targetOf(line))
      .filter(
        (target, i, all): target is LineTarget =>
          !!target && !all.slice(0, i).some((other) => sameTarget(other, target)),
      );
    return (
      <Fragment key={key}>
        <div className="grid min-w-0 grid-cols-2">
          {sides.map(({ side, line, number }) => {
            const target = line && targetOf(line);
            return (
              <div
                key={side}
                className={cn(
                  "group/line relative grid min-w-0 grid-cols-[40px_minmax(0,1fr)] overflow-hidden",
                  side === "right" && "border-l",
                  line && tone(line),
                  target && props.highlighted(target) && commented,
                )}
              >
                {line && (
                  <>
                    <Gutter line={line} value={number} />
                    <Code line={line} target={target} onComment={props.onComment} />
                  </>
                )}
              </div>
            );
          })}
        </div>
        {targets.map((target) => (
          <Fragment key={`${target.side}:${target.line}`}>
            {props.renderAnnotation(target)}
          </Fragment>
        ))}
      </Fragment>
    );
  });
}

const commented =
  "bg-[color-mix(in_oklab,var(--ring)_8%,transparent)] shadow-[inset_2px_0_0_var(--ring)]";
const tone = (line: DiffLine) =>
  line.kind === "add" ? "bg-diff-add" : line.kind === "del" ? "bg-diff-del" : "";

function Gutter(props: { line: DiffLine; value: number | undefined }) {
  return (
    <span
      aria-hidden
      className={cn(
        "pr-2.5 text-right text-[11px] text-subtle-foreground select-none",
        props.line.kind === "add" && "text-status-done",
        props.line.kind === "del" && "text-status-failed",
      )}
    >
      {props.value ?? ""}
    </span>
  );
}

function Code(props: {
  line: DiffLine;
  target: LineTarget | undefined;
  onComment(target: LineTarget): void;
}) {
  const { target } = props;
  const sign = props.line.kind === "add" ? "+" : props.line.kind === "del" ? "−" : " ";
  return (
    <span className="relative min-w-0 pl-3">
      <span className="sr-only">{sign}</span>
      {props.line.text || " "}
      {target && (
        <button
          type="button"
          aria-label={`Comment on ${target.side === "old" ? "old " : ""}line ${target.line}`}
          onClick={() => props.onComment(target)}
          className="absolute top-0.5 -left-2 grid size-4 place-items-center rounded-[4px] bg-ring text-white opacity-0 transition-opacity duration-150 group-hover/line:opacity-100 focus-visible:opacity-100"
        >
          <PlusIcon aria-hidden size={10} weight="bold" />
        </button>
      )}
    </span>
  );
}

function Fold(props: { row: Extract<DiffRow, { kind: "fold" }>; expand(row: DiffRow): void }) {
  const { row } = props;
  const label = row.count === null ? "Unchanged lines" : `${row.count} unchanged lines`;
  const className =
    "flex w-full items-center justify-center gap-1 bg-muted font-sans text-xs leading-6 text-subtle-foreground";
  if (!row.lines) return <div className={className}>{row.count === null ? "⋯" : label}</div>;
  return (
    <button
      type="button"
      onClick={() => props.expand(row)}
      className={cn(className, "hover:text-foreground")}
    >
      <CaretDownIcon aria-hidden size={12} />
      {label}
    </button>
  );
}
