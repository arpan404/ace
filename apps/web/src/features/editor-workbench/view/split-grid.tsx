import { Fragment, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import type { DeckGroup, DeckNode, SplitPath } from "./layout.ts";

/** A group never gets narrower or shorter than this by dragging an edge. */
const minGroupPx = 160;

/**
 * The editor area's split tree: each split lays its children out by weight, with an edge
 * between neighbours that resizes by drag or arrows and evens the split on double-click.
 */
export function SplitGrid(props: {
  node: DeckNode;
  path?: SplitPath;
  renderGroup(group: DeckGroup): ReactNode;
  onResize(at: SplitPath, sizes: readonly number[]): void;
}) {
  const { node } = props;
  const path = props.path ?? [];
  if (node.kind === "group") return props.renderGroup(node);
  const row = node.direction === "row";
  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1", row ? "flex-row" : "flex-col")}>
      {node.children.map((child, index) => (
        <Fragment key={child.kind === "group" ? child.id : `split-${index}`}>
          {index > 0 && (
            <SplitEdge
              row={row}
              sizes={node.sizes}
              before={index - 1}
              onResize={(sizes) => props.onResize(path, sizes)}
            />
          )}
          <div className="flex min-h-0 min-w-0" style={{ flex: `${node.sizes[index] ?? 1} 1 0px` }}>
            <SplitGrid
              node={child}
              path={[...path, index]}
              renderGroup={props.renderGroup}
              onResize={props.onResize}
            />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function SplitEdge(props: {
  row: boolean;
  sizes: readonly number[];
  /** The child before the edge; the one after is `before + 1`. */
  before: number;
  onResize(sizes: readonly number[]): void;
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
    const floor = px > 0 ? (minGroupPx / px) * total : 0;
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
      aria-label="Resize groups"
      aria-orientation={props.row ? "vertical" : "horizontal"}
      aria-valuenow={Math.round(share * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn(
        "relative z-[3] shrink-0 bg-border outline-none",
        "after:absolute after:transition-colors after:duration-(--motion-fast) hover:after:bg-ring/45 focus-visible:after:bg-ring/45",
        props.row
          ? "w-px cursor-col-resize after:inset-y-0 after:-left-[3px] after:w-[7px]"
          : "h-px cursor-row-resize after:inset-x-0 after:-top-[3px] after:h-[7px]",
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
      // Spec 18: double-click evens the sizes of this split.
      onDoubleClick={() => props.onResize(props.sizes.map(() => 1))}
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
