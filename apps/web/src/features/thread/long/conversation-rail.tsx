import { useCallback, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { FloatingContents, useFloatingMaterial } from "@/components/ui/floating-material.tsx";
import { layers } from "@/components/ui/menu-styles.ts";
import { cn } from "@/lib/cn.ts";

export interface ConversationMarker {
  id: string;
  label: string;
  ordinal: number;
}

/** Room between ticks when the rail has it; past that they close up to fit. */
export const tickSpacing = 8;
/** The closest ticks may sit: the caller shows fewer turns rather than go below it. */
export const minTickSpacing = 3;

/** How wide a tick draws at each distance from the one under the pointer. */
const reach = ["scale-x-100", "scale-x-[0.66]", "scale-x-[0.45]"] as const;

/**
 * An outline of the conversation's turns down the transcript's left edge. It is never taller
 * than `height` and never scrolls: ticks spread evenly over the rail and close up as turns are
 * added. Moving along it previews each turn at once, the ticks nearest the pointer widening; a
 * click jumps. Shown only with a fine pointer: on touch the Turns panel reaches the same turns.
 */
export function ConversationRail(props: {
  markers: readonly ConversationMarker[];
  currentId?: string;
  /** The room the rail may take, in pixels. */
  height: number;
  onJump(id: string): void;
  renderPreview(id: string): ReactNode;
  /** A wheel over the rail, so it can scroll the transcript beside it. */
  onWheel?(event: WheelEvent): void;
  className?: string;
}) {
  const { markers } = props;
  const [active, setActive] = useState<number>();
  const [focused, setFocused] = useState<string>();
  const nav = useRef<HTMLElement | null>(null);
  const { onWheel } = props;
  // Not passive, so a forwarded wheel can stop the page from scrolling as well.
  const attach = useCallback(
    (element: HTMLElement | null) => {
      nav.current = element;
      if (!element || !onWheel) return;
      element.addEventListener("wheel", onWheel, { passive: false });
      return () => element.removeEventListener("wheel", onWheel);
    },
    [onWheel],
  );
  if (markers.length < 2) return null;
  const last = markers.length - 1;
  const height = Math.max(0, Math.min(last * tickSpacing, props.height));
  const tabStop = markers.some((marker) => marker.id === focused)
    ? focused
    : (props.currentId ?? markers[0]?.id);
  const at = (index: number) => (index / last) * 100;
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const targets: Record<string, number> = {
      ArrowDown: Math.min(last, index + 1),
      ArrowUp: Math.max(0, index - 1),
      Home: 0,
      End: last,
    };
    const target = targets[event.key];
    if (target === undefined) return;
    event.preventDefault();
    nav.current?.querySelectorAll<HTMLButtonElement>("button")[target]?.focus();
  };
  const shown = active === undefined ? undefined : markers[active];
  return (
    <nav
      ref={attach}
      aria-label="Conversation turns"
      className={cn("relative hidden w-7 md:pointer-fine:block", props.className)}
      style={{ height }}
      onPointerLeave={() => setActive(undefined)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setActive(undefined);
      }}
    >
      {markers.map((marker, index) => {
        const distance = active === undefined ? undefined : Math.abs(index - active);
        const current = marker.id === props.currentId;
        return (
          <button
            key={marker.id}
            type="button"
            aria-label={marker.label}
            aria-current={current ? "location" : undefined}
            tabIndex={marker.id === tabStop ? 0 : -1}
            // Each tick owns the band around it, so the whole rail answers the pointer.
            className="absolute left-0 grid w-full -translate-y-1/2 cursor-pointer items-center outline-none focus-visible:ring-2 focus-visible:ring-ring"
            style={{ top: `${at(index)}%`, height: Math.max(minTickSpacing, height / last) }}
            onPointerEnter={() => setActive(index)}
            onFocus={() => {
              setFocused(marker.id);
              setActive(index);
            }}
            onKeyDown={(event) => move(event, index)}
            onClick={() => props.onJump(marker.id)}
          >
            <span
              aria-hidden="true"
              className={cn(
                // Width and emphasis change by scale and opacity only: the pointer sweeps
                // across many ticks a second.
                "ml-1.5 h-0.5 w-5 origin-left rounded-full transition-[scale,opacity] duration-150 motion-reduce:transition-none",
                current ? "bg-foreground" : "bg-foreground/30",
                distance === undefined ? (current ? "scale-x-100" : "scale-x-[0.45]") : "",
                distance !== undefined && (reach[distance] ?? "scale-x-[0.33]"),
                distance === 0 && !current && "bg-foreground/70",
              )}
            />
          </button>
        );
      })}
      {shown && active !== undefined && (
        <TurnCard
          top={at(active)}
          edge={active === 0 ? "start" : active === last ? "end" : undefined}
        >
          {props.renderPreview(shown.id)}
        </TurnCard>
      )}
    </nav>
  );
}

/** The hovered turn's preview, beside its tick, kept on the rail at either end. */
function TurnCard(props: { top: number; edge: "start" | "end" | undefined; children: ReactNode }) {
  const material = useFloatingMaterial();
  return (
    <div
      role="presentation"
      data-slot="hover-card-content"
      className={cn(
        material,
        layers.popup,
        "pointer-events-none absolute left-8 w-80 max-w-[calc(100vw-48px)] rounded-popup px-3.5 py-3 text-popover-foreground",
        props.edge === "start"
          ? ""
          : props.edge === "end"
            ? "-translate-y-full"
            : "-translate-y-1/2",
      )}
      style={{ top: `${props.top}%` }}
    >
      <FloatingContents glass={material === "ace-floating"}>{props.children}</FloatingContents>
    </div>
  );
}
