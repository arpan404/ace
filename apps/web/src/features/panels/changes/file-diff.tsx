import { CaretDownIcon, CodeIcon, PlusIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { Fragment, lazy, Suspense } from "react";
import { Spinner } from "@/components/ui/spinner.tsx";
import type { ReactNode } from "react";
import { pairRows, type DiffLine, type DiffRow, type SplitRow, type FileDiff } from "@ace/ui-core";
import { LongRows } from "@/components/virtual-rows.tsx";
import { DiffStat } from "./diff-stat.tsx";
import { useDiffRenderer } from "./diff-renderer.ts";

const GpuDiff = lazy(() => import("./gpu-diff.tsx"));

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

/** Above this many rows a file mounts only the rows near the viewport. */
const virtualAbove = 400;
const rowHeight = 20;

/**
 * How a file is shown: open or collapsed, which folds are expanded, and whether a huge diff is
 * read as text. Held by the list, so a file scrolled out of a long list and back keeps it.
 */
export interface FileView {
  open: boolean;
  expanded: ReadonlySet<number>;
  asText: boolean;
}
export const freshView: FileView = { open: true, expanded: new Set(), asText: false };

/** Typical height of a file block before it is measured: its header and, if open, its rows. */
export const fileHeight = (file: FileDiff, view: FileView) =>
  32 + (view.open ? file.rows.length * rowHeight : 0);

/**
 * One changed file: a sticky header that collapses it, then its lines in unified or split
 * layout. Unchanged runs fold; folds with known lines expand on click. `renderAnnotation` renders
 * the comment UI under a line; `onComment` starts one.
 */
export function FileDiffBlock(props: {
  id?: string;
  file: FileDiff;
  view: FileView;
  onView(next: FileView): void;
  mode: "unified" | "split";
  wrap: boolean;
  highlighted(target: LineTarget): boolean;
  renderAnnotation(target: LineTarget): ReactNode;
  onComment(target: LineTarget): void;
  /** Marked viewed at this version of the diff: the path dims. */
  viewed?: boolean;
  /** The header's trailing controls (Viewed, file actions). */
  actions?: ReactNode;
}) {
  const { file, view, onView } = props;
  const { open, expanded, asText } = view;
  const renderer = useDiffRenderer(file.rows.length);
  const slash = file.path.lastIndexOf("/");
  const rows: DiffRow[] = file.rows.flatMap((row, index) =>
    row.kind === "fold" && expanded.has(index) && row.lines ? row.lines : [row],
  );
  const indexOf = new Map(file.rows.map((row, index) => [row, index]));
  const expand = (row: DiffRow) => {
    const index = indexOf.get(row);
    if (index !== undefined) onView({ ...view, expanded: new Set(expanded).add(index) });
  };
  return (
    <section id={props.id} aria-label={file.path} className="min-w-0">
      <div className="sticky top-0 z-[1] flex h-8 items-center gap-1 bg-panel pr-2 shadow-[0_1px_0_var(--border)]">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => onView({ ...view, open: !open })}
          className="flex h-8 min-w-0 flex-1 items-center gap-2 pl-3.5 text-left font-mono text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:shadow-[inset_0_0_0_2px_var(--ring)]"
        >
          <CaretDownIcon
            aria-hidden
            size={14}
            className={cn(
              "shrink-0 text-subtle-foreground transition-transform duration-(--dur-2) ease-spring",
              !open && "-rotate-90",
            )}
          />
          <CodeIcon aria-hidden size={14} className="shrink-0 text-subtle-foreground" />
          <span className={cn("min-w-0 truncate", props.viewed && "opacity-70")}>
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
            className="ml-auto shrink-0 text-[12px]"
          />
        </button>
        {props.actions}
      </div>
      {open && renderer !== "dom" && !asText && (
        <Suspense fallback={<Spinner label="Loading the diff renderer" className="m-3.5" />}>
          <GpuDiff
            path={file.path}
            rows={rows}
            renderer={renderer}
            onShowText={() => onView({ ...view, asText: true })}
          />
        </Suspense>
      )}
      {open && (renderer === "dom" || asText) && (
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

function Rows<T>(props: {
  items: readonly { item: T; key: string }[];
  render(item: T, key: string): ReactNode;
}) {
  return (
    <LongRows
      items={props.items}
      virtualAbove={virtualAbove}
      rowKey={(entry) => entry.key}
      estimate={rowHeight}
      render={(entry) => props.render(entry.item, entry.key)}
    />
  );
}

function Unified(props: RowsProps) {
  return (
    <Rows
      items={keyed(props.rows, lineKey)}
      render={(row) => {
        if (row.kind === "fold") return <Fold row={row} expand={props.expand} />;
        const target = targetOf(row);
        return (
          <>
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
          </>
        );
      }}
    />
  );
}

const pairKey = (pair: SplitRow) =>
  pair.kind === "fold"
    ? lineKey(pair.row)
    : `pair:${pair.left?.old ?? ""}:${pair.right?.new ?? ""}`;

function Split(props: RowsProps) {
  return (
    <Rows
      items={keyed(pairRows(props.rows), pairKey)}
      render={(pair) => <SplitRowView pair={pair} {...props} />}
    />
  );
}

function SplitRowView(props: RowsProps & { pair: SplitRow }) {
  const { pair } = props;
  if (pair.kind === "fold") return <Fold row={pair.row} expand={props.expand} />;
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
    <>
      <div className="grid min-w-0 grid-cols-2">
        {sides.map(({ side, line, number }) => {
          const target = line && targetOf(line);
          return (
            <div
              key={side}
              className={cn(
                "group/line relative grid min-w-0 grid-cols-[40px_minmax(0,1fr)] overflow-hidden",
                side === "right" && "border-l",
                line ? tone(line) : empty,
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
        <Fragment key={`${target.side}:${target.line}`}>{props.renderAnnotation(target)}</Fragment>
      ))}
    </>
  );
}

/** The side of a split row with no line (an add's left, a delete's right): faintly hatched. */
const empty =
  "bg-[repeating-linear-gradient(-45deg,transparent_0_5px,color-mix(in_oklab,var(--foreground)_4%,transparent)_5px_6px)]";
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
          className="absolute top-0.5 -left-2 grid size-4 place-items-center rounded-xs bg-ring text-white opacity-0 transition-opacity duration-(--dur-1) group-hover/line:opacity-100 pointer-coarse:opacity-100 focus-visible:opacity-100"
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
