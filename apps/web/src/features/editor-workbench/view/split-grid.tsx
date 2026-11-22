import { Fragment, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import {
  roomNeeded,
  type GroupNode,
  type Room,
  type SplitNode,
  type NodePath,
} from "@ace/ui-core/editor-workbench";

/**
 * The editor area's split tree: each split lays its children out by weight, with an edge
 * between neighbours that resizes by drag or arrows and evens the split on double-click.
 */
export function SplitGrid(props: {
  node: SplitNode;
  path?: NodePath;
  /** Each pane's least size as drawn (`displayPanes`). */
  pane: Room;
  /** Panes folded to their strips in a stacked accordion (`collapsedPanes`). */
  folded: ReadonlySet<string>;
  renderGroup(group: GroupNode): ReactNode;
  onResize(at: NodePath, sizes: readonly number[]): void;
  /** Double-click on an edge: even sizes for that split (spec 18). */
  onEven(at: NodePath): void;
}) {
  const { node } = props;
  const path = props.path ?? [];
  if (node.kind === "group") return props.renderGroup(node);
  const row = node.direction === "row";
  // In an accordion the open children share all the room the folded strips leave, so their
  // shares are scaled to sum to one (a lone open pane takes everything).
  const open = node.children.map((child) => row || !allFolded(child, props.folded));
  const openShare = node.sizes.reduce((sum, size, i) => (open[i] ? sum + size : sum), 0) || 1;
  const grow = (index: number) =>
    open.every(Boolean) ? (node.sizes[index] ?? 1) : (node.sizes[index] ?? 1) / openShare;
  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1", row ? "flex-row" : "flex-col")}>
      {node.children.map((child, index) => (
        <Fragment key={child.kind === "group" ? child.id : `split-${index}`}>
          {index > 0 && (
            <SplitEdge
              row={row}
              sizes={node.sizes}
              before={index - 1}
              pane={props.pane}
              onResize={(sizes) => props.onResize(path, sizes)}
              onEven={() => props.onEven(path)}
            />
          )}
          <div
            className="flex min-h-0 min-w-0"
            style={
              !row && allFolded(child, props.folded)
                ? // A folded child is its strip's height; the open one takes the rest.
                  { flex: "0 0 auto" }
                : {
                    flex: `${grow(index)} 1 0px`,
                    // The split shows only while every group has its room (spec 5), so each
                    // child keeps that room whatever its stored share.
                    ...(row
                      ? { minWidth: roomNeeded(child, props.pane).width }
                      : { minHeight: roomNeeded(child, props.pane).height }),
                  }
            }
          >
            <SplitGrid
              node={child}
              path={[...path, index]}
              pane={props.pane}
              folded={props.folded}
              renderGroup={props.renderGroup}
              onResize={props.onResize}
              onEven={props.onEven}
            />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

/** Every pane in `node` is folded to its strip. */
function allFolded(node: SplitNode, folded: ReadonlySet<string>): boolean {
  return node.kind === "group"
    ? folded.has(node.id)
    : node.children.every((child) => allFolded(child, folded));
}

function SplitEdge(props: {
  row: boolean;
  /** Each pane's least size: a drag stops there. */
  pane: Room;
  sizes: readonly number[];
  /** The child before the edge; the one after is `before + 1`. */
  before: number;
  onResize(sizes: readonly number[]): void;
  onEven(): void;
}) {
  const drag = useRef<{ pointer: number; start: number; px: number; sizes: number[] } | undefined>(
    undefined,
  );
  const total = props.sizes.reduce((sum, size) => sum + size, 0);
  const share = (props.sizes[props.before] ?? 0) / (total || 1);
  // Move `delta` (in weight units) from the child after the edge to the one before.
  const shift = (from: readonly number[], delta: number, px: number) => {
    const a = from[props.before] ?? 0;
    const b = from[props.before + 1] ?? 0;
    // A pane never gets narrower or shorter by dragging than the room it shows in.
    const least = props.row ? props.pane.width : props.pane.height;
    const floor = px > 0 ? (least / px) * total : 0;
    const moved = Math.min(Math.max(delta, floor - a), b - floor);
    const next = [...from];
    next[props.before] = a + moved;
    next[props.before + 1] = b - moved;
    props.onResize(next);
  };
  const containerPx = (element: HTMLElement) => {
    const box = element.parentElement?.getBoundingClientRect();
    return box ? (props.row ? box.width : box.height) : 0;
  };
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label="Resize panes"
      aria-orientation={props.row ? "vertical" : "horizontal"}
      aria-valuenow={Math.round(share * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn(
        "group/edge relative z-[3] shrink-0 bg-border outline-none",
        // `after`: the invisible 9px the pointer takes. `before`: a 3px line that shows only
        // while the edge is held, hovered a moment, or focused.
        "after:absolute before:pointer-events-none before:absolute before:bg-ring/50 before:opacity-0",
        "before:transition-opacity before:duration-(--motion-fast) hover:before:opacity-100 hover:before:delay-150 focus-visible:before:opacity-100 active:before:opacity-100",
        props.row
          ? "w-px cursor-col-resize after:inset-y-0 after:-left-1 after:w-[9px] before:inset-y-0 before:-left-px before:w-[3px]"
          : "h-px cursor-row-resize after:inset-x-0 after:-top-1 after:h-[9px] before:inset-x-0 before:-top-px before:h-[3px]",
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        drag.current = {
          pointer: event.pointerId,
          start: props.row ? event.clientX : event.clientY,
          px: containerPx(event.currentTarget),
          sizes: [...props.sizes],
        };
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || current.pointer !== event.pointerId || current.px <= 0) return;
        const moved = (props.row ? event.clientX : event.clientY) - current.start;
        shift(current.sizes, (moved / current.px) * total, current.px);
      }}
      onPointerUp={() => (drag.current = undefined)}
      onPointerCancel={() => (drag.current = undefined)}
      onDoubleClick={props.onEven}
      onKeyDown={(event) => {
        const back = props.row ? "ArrowLeft" : "ArrowUp";
        const forward = props.row ? "ArrowRight" : "ArrowDown";
        if (event.key !== back && event.key !== forward) return;
        event.preventDefault();
        const step = (event.shiftKey ? 0.15 : 0.05) * total;
        shift(props.sizes, event.key === forward ? step : -step, containerPx(event.currentTarget));
      }}
    />
  );
}
