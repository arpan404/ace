import {
  useCallback,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { FloatingContents, useFloatingMaterial } from "@/components/ui/floating-material.tsx";
import { layers } from "@/components/ui/menu-styles.ts";
import { cn } from "@/lib/cn.ts";
import { useRailHighlight, type RailHighlightTime } from "./use-rail-highlight.ts";

export interface ConversationMarker {
  id: string;
  label: string;
  ordinal: number;
}

/** Room between ticks when the rail has it; past that they close up to fit. */
export const tickSpacing = 8;
/** The closest ticks may sit: the caller shows fewer turns rather than go below it. */
export const minTickSpacing = 3;

/**
 * An outline of the conversation's turns down the transcript's left edge. It is never taller
 * than `height` and never scrolls: ticks spread evenly over the rail and close up as turns are
 * added. Every tick is the same size: the reader's turn and the tick under the pointer only draw
 * brighter, and the reader's mark steps aside while the transcript is flung so it never flickers.
 * A click jumps. Keyboard focus on a tick previews its turn; the pointer sweeping past never pops
 * a card. Shown only with a fine pointer: on touch the Turns panel reaches the same turns.
 */
export function ConversationRail(props: {
  markers: readonly ConversationMarker[];
  /** The room the rail may take, in pixels. */
  height: number;
  onJump(id: string): void;
  renderPreview(id: string): ReactNode;
  /** The reader's turn, marked whenever the transcript is not being flung. */
  current?: string;
  /** The transcript beside the rail: its scroll speed decides when the mark shows. */
  scroller?: RefObject<HTMLElement | null> | undefined;
  /** The clock scroll speed is measured on; tests pass a fake. */
  time?: RailHighlightTime;
  /** A wheel over the rail, so it can scroll the transcript beside it. */
  onWheel?(event: WheelEvent): void;
  className?: string;
}) {
  const { markers } = props;
  const settled = useRailHighlight(props.scroller, props.time);
  const current = settled ? props.current : undefined;
  // The tick under the pointer, which only brightens, and the keyboard-focused one, which previews.
  const [hovered, setHovered] = useState<number>();
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
      onPointerLeave={() => setHovered(undefined)}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        setHovered(undefined);
        setPreviewed(undefined);
      }}
    >
      {markers.map((marker, index) => {
        const reading = marker.id === current;
        return (
          <button
            key={marker.id}
            type="button"
            aria-label={marker.label}
            aria-current={reading ? "location" : undefined}
            tabIndex={marker.id === tabStop ? 0 : -1}
            // Each tick owns the band around it, so the whole rail answers the pointer.
            className="absolute left-0 grid w-full -translate-y-1/2 cursor-pointer items-center outline-none focus-visible:ring-2 focus-visible:ring-ring"
            style={{ top: `${at(index)}%`, height: Math.max(minTickSpacing, height / last) }}
            onPointerEnter={() => setHovered(index)}
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
                // One size for every tick: emphasis is colour alone, so neither the pointer
                // sweeping past nor the reader's turn moving shifts anything on the rail.
                "ml-2 h-0.5 w-3 rounded-full transition-colors duration-(--motion-fast) ease-(--ease-out) motion-reduce:transition-none",
                reading
                  ? "bg-muted-foreground"
                  : hovered === index || previewed === index
                    ? "bg-subtle-foreground"
                    : "bg-faint-foreground",
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
