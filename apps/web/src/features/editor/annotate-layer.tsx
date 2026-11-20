import type { Position } from "@ace/editor";
import { codeIntentWords, type CodeAnnotation, type CodeAnnotationIntent } from "@ace/ui-core";
import type { PointerEvent as ReactPointerEvent, ReactNode, SyntheticEvent } from "react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { useFloatingMaterial } from "@/components/ui/floating-material.tsx";
import { Menu, MenuContent, MenuItem } from "@/components/ui/menu.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { CommentPopover, MarkerNumber } from "@/features/annotations/index.ts";
import type { Span } from "./annotate-anchor.ts";
import type { EditorLayerView } from "./layer.ts";
import { rowOffset } from "./wrap.ts";

/** What the layer has open: a new annotation's comment, an existing one, or the menu. */
export type Open =
  | {
      kind: "new";
      span: Span;
      intent?: CodeAnnotationIntent | undefined;
      comment: string;
      /** Which comment this is: its popover keeps what was typed while its code moves. */
      seq: number;
      /** The code as it was marked, saved as is once the code is gone. */
      marked: { excerpt: string; cut?: true | undefined };
      /** The code it was opened on changed or went away since. */
      outdated?: boolean | undefined;
    }
  | { kind: "edit"; id: string }
  | { kind: "menu"; span: Span; x: number; y: number };

export interface LayerActions {
  annotate(span: Span, intent?: CodeAnnotationIntent): void;
  save(open: Open, comment: string, intent: CodeAnnotationIntent | undefined): void;
  remove(id: string): void;
  close(): void;
  /** The menu went away; whatever it opened stays. */
  closeMenu(): void;
  edit(id: string): void;
}

const quick: readonly CodeAnnotationIntent[] = ["ask", "fix", "explain"];
/** Where a marker sits in the gutter's annotation strip. */
const markerLeft = 2;
/** The last line a span uses: a span ending at a line's start stops on the line before. */
const lastLine = (span: Span) =>
  span.end.column === 0 && span.end.line > span.start.line ? span.end.line - 1 : span.end.line;
const compare = (a: Position, b: Position) => a.line - b.line || a.column - b.column;

/** The primary selection as a span, when it holds any text. */
export function selectedSpan(view: EditorLayerView): Span | undefined {
  const selection = view.selections[view.primary] ?? view.selections[0];
  if (!selection) return undefined;
  const { anchor, head } = selection;
  const order = compare(anchor, head);
  if (order === 0) return undefined;
  return order < 0 ? { start: anchor, end: head } : { start: head, end: anchor };
}

/** "12–18", the lines a span covers as its badge reads. */
export function linesBadge(span: Span): string {
  const last =
    span.end.column === 0 && span.end.line > span.start.line ? span.end.line : span.end.line + 1;
  const first = span.start.line + 1;
  return last > first ? `${first}–${last}` : String(first);
}

/** One box per visual row a span covers inside the drawn window. */
function rowBoxes(view: EditorLayerView, span: Span, key: string) {
  const boxes: { key: string; left: number; top: number; width: number }[] = [];
  const { layout } = view;
  const from = Math.max(view.firstLine, span.start.line);
  const to = Math.min(view.lastLine, span.end.line);
  for (let line = from; line <= to; line++) {
    const text = view.line(line);
    const rows = layout.rowsOf(line);
    const startRow = layout.startOf(line);
    const low = line === span.start.line ? span.start.column : 0;
    const high = line === span.end.line ? span.end.column : text.length;
    const first = Math.max(0, view.firstRow - startRow);
    const last = Math.min(rows.length, view.lastRow - startRow);
    for (let at = first; at < last; at++) {
      const row = rows.at(at);
      if (!row) continue;
      const start = Math.max(low, row.start);
      const end = Math.min(high, row.end);
      // A whole line's range runs to the row's edge; an empty line still shows a sliver.
      const toEdge = line < span.end.line && end >= Math.min(row.end, text.length);
      if (end < start || (end === start && !toEdge)) continue;
      const left = view.gutter + rowOffset(text, row, start) * view.cell;
      const right = view.gutter + rowOffset(text, row, end) * view.cell + (toEdge ? view.cell : 0);
      boxes.push({
        key: `${key}-${line}-${at}`,
        left,
        top: (startRow + at) * view.lineHeight,
        width: right - left,
      });
    }
  }
  return boxes;
}

/** A point in the text as a popup's anchor, following the editor as it scrolls. */
function anchorAt(view: EditorLayerView, position: Position, below: boolean) {
  const host = view.host;
  const point = view.pointOf(position);
  return {
    getBoundingClientRect: () => {
      const rect = host?.getBoundingClientRect();
      const left = (rect?.left ?? 0) + point.left;
      const top = (rect?.top ?? 0) + point.top + (below ? view.lineHeight : 0);
      return new DOMRect(left, top, 0, below ? 0 : view.lineHeight);
    },
    ...(host ? { contextElement: host } : {}),
  };
}

/** A press inside the layer is its own: the editor beneath must not move its caret for it. */
const keep = (event: ReactPointerEvent | SyntheticEvent) => event.stopPropagation();

/**
 * Popups are portalled, but React still bubbles their events through the editor's scroller,
 * whose pointer handlers would take focus and move the caret: they stop here.
 */
function Contained(props: { children: ReactNode }) {
  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- it only stops events on their way out; the popups inside take them.
    <div
      className="contents"
      onPointerDown={keep}
      onPointerMove={keep}
      onPointerUp={keep}
      onClick={keep}
      onDoubleClick={keep}
      onContextMenu={keep}
    >
      {props.children}
    </div>
  );
}

/**
 * Code annotations drawn in the editor: a soft wash over each range and its number in the
 * gutter (the Browser's numbered pins, in the editor's gutter), only for the rows on screen. A
 * selection shows a small bar to annotate it or ask for something about it; the comment opens
 * beside the code. An outdated annotation keeps its number where its code was, muted, with no
 * range.
 */
export function AnnotationLayer(props: {
  view: EditorLayerView;
  annotations: readonly CodeAnnotation[];
  open: Open | undefined;
  actions: LayerActions;
}) {
  const { view, annotations, open, actions } = props;
  const material = useFloatingMaterial();
  const pressing = usePressing();
  const span = selectedSpan(view);
  const visible = annotations.filter(
    (each) => each.end.line >= view.firstLine && each.start.line <= view.lastLine,
  );
  const editing =
    open?.kind === "edit" ? annotations.find((each) => each.id === open.id) : undefined;
  // Several annotations on one line overlap a little, the newest on top.
  const onLine = new Map<number, number>();
  return (
    <>
      <div aria-hidden className="pointer-events-none absolute inset-0 z-[1]">
        {visible.flatMap((each) =>
          each.outdated
            ? []
            : rowBoxes(view, each, each.id).map((box) => (
                <div
                  key={box.key}
                  data-annotated-range={each.number}
                  className="absolute bg-ring/14"
                  style={{
                    left: box.left,
                    top: box.top,
                    width: box.width,
                    height: view.lineHeight,
                  }}
                />
              )),
        )}
        {open?.kind === "new" &&
          rowBoxes(view, open.span, "new").map((box) => (
            <div
              key={box.key}
              className="absolute bg-ring/20"
              style={{ left: box.left, top: box.top, width: box.width, height: view.lineHeight }}
            />
          ))}
      </div>
      <div className="pointer-events-none sticky left-0 z-[3] h-0" style={{ width: view.gutter }}>
        {visible
          .filter((each) => !each.outdated)
          .map((each) => {
            // A thin bar beside the numbers spans the lines the annotation covers.
            const { layout } = view;
            const last = lastLine(each);
            const top = Math.max(layout.startOf(each.start.line), view.firstRow);
            const bottom = Math.min(
              layout.startOf(last) + Math.max(1, layout.rowsOf(last).length),
              view.lastRow,
            );
            if (bottom <= top) return null;
            return (
              <div
                key={`bar-${each.id}`}
                aria-hidden
                className="absolute w-0.5 rounded-full bg-tint/60"
                style={{
                  left: markerLeft + 7,
                  top: top * view.lineHeight + 4,
                  height: (bottom - top) * view.lineHeight - 8,
                }}
              />
            );
          })}
        {visible
          .filter((each) => each.start.line >= view.firstLine)
          .map((each) => {
            const index = onLine.get(each.start.line) ?? 0;
            onLine.set(each.start.line, index + 1);
            const top = view.layout.startOf(each.start.line) * view.lineHeight + 3;
            const lines = linesBadge(each);
            const words = each.comment || (each.intent ? codeIntentWords[each.intent] : "");
            return (
              <Tip
                key={each.id}
                label={`${each.outdated ? "Outdated · " : ""}${words || `Lines ${lines}`}`}
                side="right"
              >
                <button
                  type="button"
                  data-code-annotation={each.number}
                  data-outdated={each.outdated || undefined}
                  aria-label={`Annotation ${each.number}, ${each.outdated ? "outdated, " : ""}line${lines.includes("–") ? "s" : ""} ${lines}`}
                  onPointerDown={keep}
                  onClick={() => actions.edit(each.id)}
                  className={cn(
                    "pointer-events-auto absolute grid size-4 place-items-center rounded-full focus-ring",
                    each.outdated && "opacity-70 grayscale",
                  )}
                  style={{ top, left: markerLeft + index * 4 }}
                >
                  <MarkerNumber number={each.number} />
                </button>
              </Tip>
            );
          })}
      </div>
      {span && !open && !pressing && (
        <SelectionBar
          view={view}
          span={span}
          material={material}
          onAnnotate={(intent) => actions.annotate(span, intent)}
        />
      )}
      <Contained>
        {open?.kind === "new" && (
          <CommentPopover
            key={`new-${open.seq}-${open.intent ?? ""}`}
            anchor={anchorAt(view, open.span.end, true)}
            lines={linesBadge(open.span)}
            comment={open.comment}
            intent={open.intent}
            onSave={(comment, intent) => actions.save(open, comment, intent)}
            onCancel={actions.close}
          />
        )}
        {open?.kind === "edit" && editing && (
          <CommentPopover
            key={editing.id}
            anchor={anchorAt(view, editing.outdated ? editing.start : editing.end, true)}
            lines={linesBadge(editing)}
            number={editing.number}
            comment={editing.comment}
            intent={editing.intent}
            outdated={editing.outdated}
            onSave={(comment, intent) => actions.save(open, comment, intent)}
            onCancel={actions.close}
            onDelete={() => actions.remove(editing.id)}
          />
        )}
        {open?.kind === "menu" && (
          <Menu
            open
            onOpenChange={(next) => {
              if (!next) actions.closeMenu();
            }}
          >
            <MenuContent
              anchor={{ getBoundingClientRect: () => new DOMRect(open.x, open.y, 0, 0) }}
              aria-label="Annotate"
            >
              <MenuItem
                keys="mod+shift+a"
                resolve={false}
                onClick={() => actions.annotate(open.span)}
              >
                Annotate
              </MenuItem>
              {quick.map((intent) => (
                <MenuItem key={intent} onClick={() => actions.annotate(open.span, intent)}>
                  {codeIntentWords[intent]}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        )}
      </Contained>
    </>
  );
}

/**
 * The bar under a selection: Annotate writes a comment; the quick actions start one with what
 * the person wants already said. Hidden while the pointer is still selecting.
 */
function SelectionBar(props: {
  view: EditorLayerView;
  span: Span;
  material: string;
  onAnnotate(intent?: CodeAnnotationIntent): void;
}) {
  const { view, span } = props;
  const last =
    span.end.column === 0 && span.end.line > span.start.line
      ? { line: span.end.line - 1, column: 0 }
      : span.end;
  const row =
    view.layout.startOf(last.line) + Math.max(0, view.layout.rowsOf(last.line).length - 1);
  const left = Math.max(view.gutter + 4, view.pointOf(span.start).left - 4);
  return (
    <div
      role="toolbar"
      aria-label="Annotate selection"
      data-annotate-bar
      onPointerDown={keep}
      className={cn(
        props.material,
        "absolute z-[4] flex h-8 items-center gap-0.5 rounded-lg p-1 font-sans",
      )}
      style={{ left, top: (row + 1) * view.lineHeight + 4 }}
    >
      <Tip label="Annotate" keys="mod+shift+a" resolve={false}>
        <Button
          size="xs"
          variant="ghost"
          className="text-foreground"
          onClick={() => props.onAnnotate()}
        >
          Annotate
        </Button>
      </Tip>
      <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
      {quick.map((intent) => (
        <Button key={intent} size="xs" variant="ghost" onClick={() => props.onAnnotate(intent)}>
          {codeIntentWords[intent]}
        </Button>
      ))}
    </div>
  );
}

/** Whether the primary button is down: the bar waits for a drag selection to end. */
function usePressing(): boolean {
  const [pressing, setPressing] = useState(false);
  useEffect(() => {
    const down = (event: PointerEvent) => {
      const onBar = event.target instanceof Element && event.target.closest("[data-annotate-bar]");
      if (event.button === 0 && !onBar) setPressing(true);
    };
    const up = () => setPressing(false);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    };
  }, []);
  return pressing;
}
