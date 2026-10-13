import { DiffCode, DiffCodeScope } from "./diff-code.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { CaretDownIcon, CodeIcon, DotsThreeIcon, PlusIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { lazy, Suspense, useMemo, useState, type PointerEvent } from "react";
import { Spinner } from "@/components/ui/spinner.tsx";
import type { ReactNode } from "react";
import { pairRows, type DiffLine, type DiffRow, type SplitRow, type FileDiff } from "@ace/ui-core";
import { LongRows } from "@/components/virtual-rows.tsx";
import { DiffStat } from "./diff-stat.tsx";
import { createPairedRowHeights } from "./paired-row-heights.ts";
import { useDiffRenderer } from "./diff-renderer.ts";
import type { FileView } from "./file-view.ts";

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
/** Lines on one side of a diff, first to last: what a comment is about. */
export interface LineRange {
  side: "old" | "new";
  start: number;
  end: number;
}
export const inRange = (range: LineRange | undefined, target: LineTarget) =>
  !!range && range.side === target.side && target.line >= range.start && target.line <= range.end;
/** The protocol's limit on a comment's lines. */
const maxRange = 100;
const ordered = (side: LineRange["side"], a: number, b: number): LineRange => {
  const start = Math.min(a, b);
  return { side, start, end: Math.min(Math.max(a, b), start + maxRange - 1) };
};

/** Above this many rows a file mounts only the rows near the viewport. */
const virtualAbove = 400;
const rowHeight = 20;

export { freshView, type FileView } from "./file-view.ts";

/** Typical height of a file block before it is measured: its header and, if open, its rows. */
export const fileHeight = (file: FileDiff, view: FileView) =>
  32 + (view.open ? file.rows.length * rowHeight : 0);

/**
 * One changed file: a sticky header that collapses it, then its lines in unified or split
 * layout. Unchanged runs fold; folds with known lines expand on click. `renderAnnotation` renders
 * the comment UI under a line; `onComment` starts one on the lines picked: a line's +, a drag
 * from it across more lines, or a shift-click extending the comment being written.
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
  onComment?: ((range: LineRange) => void) | undefined;
  onExtend?: ((range: LineRange) => void) | undefined;
  /** The lines of the comment being written here, which a shift-click extends. */
  selection?: LineRange | undefined;
  /** Marked viewed at this version of the diff: the path dims. */
  viewed?: boolean | undefined;
  /** The header's trailing controls (Viewed, file actions). */
  actions?: ReactNode;
  statusIcon?: ReactNode;
  whitespace?: boolean | undefined;
}) {
  const { file, view, onView } = props;
  const { open, expanded, asText } = view;
  const [drag, setDrag] = useState<LineRange>();
  // The GPU view supports one unwrapped column; split and soft wrap use virtualized DOM rows.
  const renderer = useDiffRenderer(props.mode === "unified" && !props.wrap ? file.rows.length : 0);
  const slash = file.path.lastIndexOf("/");
  const rows: DiffRow[] = file.rows.flatMap((row, index) =>
    row.kind === "fold" && expanded.has(index) && row.lines ? row.lines : [row],
  );
  const indexOf = new Map(file.rows.map((row, index) => [row, index]));
  // A drag from a line's + across more lines picks them; the comment opens on release.
  const startPick = (target: LineTarget, event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !props.onComment) return;
    event.preventDefault();
    const extending = event.shiftKey && props.selection?.side === target.side;
    const from = extending ? (props.selection?.start ?? target.line) : target.line;
    let range = ordered(target.side, from, target.line);
    setDrag(range);
    const move = (over: globalThis.PointerEvent) => {
      const line =
        over.target instanceof Element
          ? over.target.closest<HTMLElement>(`[data-side="${target.side}"][data-line]`)?.dataset
              .line
          : undefined;
      if (line === undefined) return;
      range = ordered(target.side, from, Number(line));
      setDrag(range);
    };
    const end = () => {
      window.removeEventListener("pointerover", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      setDrag(undefined);
      if (extending && props.onExtend) props.onExtend(range);
      else props.onComment?.(range);
    };
    window.addEventListener("pointerover", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  const picking = {
    highlighted: (target: LineTarget) => inRange(drag, target) || props.highlighted(target),
    onPick: startPick,
  };
  const expand = (row: DiffRow) => {
    const index = indexOf.get(row);
    if (index !== undefined) onView({ ...view, expanded: new Set(expanded).add(index) });
  };
  return (
    <DiffCodeScope path={file.path} rows={rows} whitespace={props.whitespace}>
      <section id={props.id} aria-label={file.path} className="min-w-0">
        <div className="sticky top-0 z-[1] flex h-8 items-center gap-1 bg-panel pr-2 shadow-[0_1px_0_var(--border)]">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => onView({ ...view, open: !open })}
            className="flex h-8 min-w-0 flex-1 items-center gap-2 pl-3.5 text-left font-mono text-sm text-muted-foreground outline-none hover:text-foreground focus-ring-inset"
          >
            <CaretDownIcon
              aria-hidden
              size={14}
              className={cn(
                "shrink-0 text-subtle-foreground transition-transform duration-(--motion-base) ease-spring",
                !open && "-rotate-90",
              )}
            />
            {props.statusIcon ?? (
              <CodeIcon aria-hidden size={14} className="shrink-0 text-subtle-foreground" />
            )}
            <span className={cn("min-w-0 truncate", props.viewed && "opacity-70")}>
              {file.movedFrom && <span>{file.movedFrom} → </span>}
              {file.path.slice(0, slash + 1)}
              <b className="font-medium text-foreground">{file.path.slice(slash + 1)}</b>
            </span>
            {file.status !== "modified" && (
              <span className="shrink-0 font-sans text-xs text-subtle-foreground">
                {file.status}
              </span>
            )}
            <DiffStat
              additions={file.additions}
              deletions={file.deletions}
              className="ml-auto shrink-0 text-sm"
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
              "font-mono text-sm leading-5",
              props.wrap
                ? "whitespace-pre-wrap [word-break:normal] [overflow-wrap:normal]"
                : "whitespace-pre",
              props.mode === "unified" && "overflow-x-auto overflow-y-hidden",
            )}
          >
            {props.mode === "unified" ? (
              <Unified rows={rows} expand={expand} {...props} {...picking} />
            ) : (
              <Split rows={rows} expand={expand} {...props} {...picking} />
            )}
          </div>
        )}
      </section>
    </DiffCodeScope>
  );
}

type RowsProps = Parameters<typeof FileDiffBlock>[0] & {
  rows: DiffRow[];
  expand(row: DiffRow): void;
  onPick(target: LineTarget, event: PointerEvent<HTMLButtonElement>): void;
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
              data-diff-row
              className={cn(
                "group/line relative grid min-w-max grid-cols-[44px_44px_minmax(0,1fr)]",
                props.wrap && "min-w-0",
                tone(row),
                target && props.highlighted(target) && commented,
              )}
            >
              <Gutter line={row} value={row.old} />
              <Gutter line={row} value={row.new} />
              <Code line={row} target={target} onComment={props.onComment} onPick={props.onPick} />
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

/** Each version scrolls horizontally on its own; paired rows keep one vertical rhythm. */
function Split(props: RowsProps) {
  const pairs = useMemo(() => keyed(pairRows(props.rows), pairKey), [props.rows]);
  const heights = useMemo(() => createPairedRowHeights(), []);
  return (
    <div className="grid min-w-0 grid-cols-2">
      {(["old", "new"] as const).map((side) => (
        <div
          key={side}
          role="region"
          aria-label={`${props.file.path} ${side === "old" ? "before" : "after"}`}
          tabIndex={0}
          data-diff-side={side}
          className={cn(
            "min-w-0 overflow-x-auto overflow-y-hidden focus-ring-inset",
            side === "new" && "border-l",
          )}
        >
          <div className={props.wrap ? "min-w-0" : "w-max min-w-full"}>
            <Rows
              items={pairs}
              render={(pair, key) => (
                <div data-diff-row data-diff-pair={key}>
                  <div ref={(node) => heights.attach(key, node)}>
                    <SplitSideRow pair={pair} side={side} {...props} />
                  </div>
                </div>
              )}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function SplitSideRow(props: RowsProps & { pair: SplitRow; side: "old" | "new" }) {
  const { pair, side } = props;
  if (pair.kind === "fold") return <Fold row={pair.row} expand={props.expand} />;
  const line = side === "old" ? pair.left : pair.right;
  const number = side === "old" ? line?.old : line?.new;
  const target = number === undefined ? undefined : { side, line: number };
  return (
    <>
      <div
        className={cn(
          "group/line relative grid min-h-5 min-w-full w-max grid-cols-[40px_max-content]",
          props.wrap && "w-full min-w-0 grid-cols-[40px_minmax(0,1fr)]",
          line ? tone(line) : empty,
          target && props.highlighted(target) && commented,
        )}
      >
        {line && (
          <>
            <Gutter line={line} value={number} />
            <Code line={line} target={target} onComment={props.onComment} onPick={props.onPick} />
          </>
        )}
      </div>
      {target && props.renderAnnotation(target)}
    </>
  );
}

/** The side of a split row with no line (an add's left, a delete's right): faintly hatched. */
const empty =
  "bg-[repeating-linear-gradient(-45deg,transparent_0_5px,color-mix(in_oklab,var(--foreground)_4%,transparent)_5px_6px)]";
const commented = "bg-ring/8 shadow-[inset_2px_0_0_var(--ring)]";
const tone = (line: DiffLine) =>
  line.kind === "add" ? "bg-diff-add" : line.kind === "del" ? "bg-diff-del" : "";

function Gutter(props: { line: DiffLine; value: number | undefined }) {
  return (
    <span
      aria-hidden
      className={cn(
        "pr-2.5 text-right text-xs text-subtle-foreground select-none",
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
  onComment?: ((range: LineRange) => void) | undefined;
  onPick(target: LineTarget, event: PointerEvent<HTMLButtonElement>): void;
}) {
  const { target } = props;
  const sign = props.line.kind === "add" ? "+" : props.line.kind === "del" ? "−" : " ";
  return (
    <span className="relative min-w-0 pl-3" data-side={target?.side} data-line={target?.line}>
      <span className="sr-only">{sign}</span>
      <DiffCode line={props.line} />
      {target && props.onComment && (
        <Tip label={`Comment on ${target.side === "old" ? "old " : ""}line ${target.line}`}>
          <button
            type="button"
            aria-label={`Comment on ${target.side === "old" ? "old " : ""}line ${target.line}`}
            onPointerDown={(event) => props.onPick(target, event)}
            // A pointer picks on release (above); a key press comments on this line alone.
            onClick={(event) => {
              if (event.detail === 0)
                props.onComment?.({ side: target.side, start: target.line, end: target.line });
            }}
            className="absolute top-0.5 -left-2 grid size-4 place-items-center rounded-xs bg-ring text-white opacity-0 transition-opacity duration-(--motion-fast) group-hover/line:opacity-100 focus-visible:opacity-100 pointer-coarse:bg-transparent pointer-coarse:text-muted-foreground pointer-coarse:opacity-100"
          >
            <PlusIcon aria-hidden size={10} weight="bold" />
          </button>
        </Tip>
      )}
    </span>
  );
}

function Fold(props: { row: Extract<DiffRow, { kind: "fold" }>; expand(row: DiffRow): void }) {
  const { row } = props;
  const label = row.count === null ? "Unchanged lines" : `${row.count} unchanged lines`;
  const className =
    "flex w-full items-center justify-center gap-1 bg-muted font-sans text-xs leading-6 text-subtle-foreground";
  if (!row.lines)
    return (
      <div className={className}>
        <DotsThreeIcon aria-hidden size={12} weight="bold" />
        {label}
      </div>
    );
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
