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
 * added. The ticks nearest the pointer widen; a click jumps. Keyboard focus on a tick previews
 * its turn; the pointer sweeping past never pops a card. Shown only with a fine pointer: on touch
 * the Turns panel reaches the same turns.
 */
export function ConversationRail(props: {
  markers: readonly ConversationMarker[];
  /** The room the rail may take, in pixels. */
  height: number;
  onJump(id: string): void;
  renderPreview(id: string): ReactNode;
  /** A wheel over the rail, so it can scroll the transcript beside it. */
  onWheel?(event: WheelEvent): void;
  className?: string;
}) {
  const { markers } = props;
  // The tick under the pointer, which only widens, and the keyboard-focused one, which previews.
  const [active, setActive] = useState<number>();
  const [previewed, setPreviewed] = useState<number>();
  const [focused, setFocused] = useState<string>();
  // Set by a press on a tick, so the focus that press brings doesn't preview.
  const pressed = useRef(false);
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
  const tabStop = markers.some((marker) => marker.id === focused) ? focused : markers[0]?.id;
  const at = (index: number) => (index / last) * 100;
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const targets: Record<string, number> = {
      ArrowDown: Math.min(last, index + 1),
      ArrowUp: Math.max(0, index - 1),
      Home: 0,
      End: last,
    };
    if (event.key === "Escape" && previewed !== undefined) {
      event.preventDefault();
      setPreviewed(undefined);
      return;
    }
    const target = targets[event.key];
    if (target === undefined) return;
    event.preventDefault();
    nav.current?.querySelectorAll<HTMLButtonElement>("button")[target]?.focus();
  };
  const shown = previewed === undefined ? undefined : markers[previewed];
  return (
    <nav
      ref={attach}
      aria-label="Conversation turns"
      className={cn("relative hidden w-7 md:pointer-fine:block", props.className)}
      style={{ height }}
      onPointerLeave={() => setActive(undefined)}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        setActive(undefined);
        setPreviewed(undefined);
      }}
    >
      {markers.map((marker, index) => {
        const near = active ?? previewed;
        const distance = near === undefined ? undefined : Math.abs(index - near);
        return (
          <button
            key={marker.id}
            type="button"
            aria-label={marker.label}
            tabIndex={marker.id === tabStop ? 0 : -1}
            // Each tick owns the band around it, so the whole rail answers the pointer.
            className="absolute left-0 grid w-full -translate-y-1/2 cursor-pointer items-center outline-none focus-visible:ring-2 focus-visible:ring-ring"
            style={{ top: `${at(index)}%`, height: Math.max(minTickSpacing, height / last) }}
            onPointerEnter={() => setActive(index)}
            onFocus={() => {
              setFocused(marker.id);
              // A click focuses the tick too; it jumps, and only keyboard focus previews.
              setPreviewed(pressed.current ? undefined : index);
              pressed.current = false;
            }}
            onPointerDown={() => (pressed.current = true)}
            onKeyDown={(event) => move(event, index)}
            onClick={() => {
              // Some browsers don't focus a clicked button: the press ends here either way.
              pressed.current = false;
              props.onJump(marker.id);
            }}
          >
            <span
              aria-hidden="true"
              className={cn(
                // Width and emphasis change by scale and opacity only: the pointer sweeps
                // across many ticks a second. Every tick looks the same: the reader's
                // turn is never emphasized.
                "ml-1.5 h-0.5 w-5 origin-left rounded-full bg-foreground/30 transition-[scale,opacity] duration-150 motion-reduce:transition-none",
                distance === undefined ? "scale-x-[0.45]" : "",
                distance !== undefined && (reach[distance] ?? "scale-x-[0.33]"),
                distance === 0 && "bg-foreground/70",
              )}
            />
          </button>
        );
      })}
      {shown && previewed !== undefined && (
        <TurnCard
          top={at(previewed)}
          edge={previewed === 0 ? "start" : previewed === last ? "end" : undefined}
        >
          {props.renderPreview(shown.id)}
        </TurnCard>
      )}
    </nav>
  );
}

/** The focused turn's preview, beside its tick, kept on the rail at either end. */
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
