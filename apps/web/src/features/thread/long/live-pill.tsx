import { CaretDownIcon } from "@phosphor-icons/react";
import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn.ts";
import { floatingControl, floatingHover, floatingMotion } from "./floating.ts";

/**
 * Where focus goes when Scroll to end leaves while holding it: the composer's
 * input, where typing continues. The transcript's other handoffs (a request
 * stack closing, a decision made) land there too.
 */
function focusComposer(): void {
  document
    .querySelector<HTMLElement>('[data-composer-area] [role="combobox"]')
    ?.focus({ preventScroll: true });
}

/**
 * Back to the live end: a pill centred over the composer, clear of it and of the strip on its
 * top edge (`--composer-clearance` is the dock's measured height). It says how many items
 * arrived since the reader left.
 */
export function LivePill(props: {
  newItems: number;
  /** More arrived than the live window holds. */
  more: boolean;
  /** Leaving: it plays its exit and takes no input. */
  phase?: "enter" | "exit";
  onClick(): void;
}) {
  const count = props.newItems
    ? `${props.newItems.toLocaleString("en-US")}${props.more ? "+" : ""} new`
    : "";
  const leaving = props.phase === "exit";
  const button = useRef<HTMLButtonElement>(null);
  // While the pill holds focus it stays exposed: aria-hidden + inert on a
  // focused button makes Chromium log "Blocked aria-hidden ..." and strands
  // keyboard users. Focus leaves for the composer first; hiding follows.
  const [heldFocus, setHeldFocus] = useState(false);
  useLayoutEffect(() => {
    if (leaving && button.current?.contains(document.activeElement)) focusComposer();
  }, [leaving]);
  const hidden = leaving && !heldFocus;
  return (
    <button
      ref={button}
      type="button"
      onClick={() => {
        if (button.current?.contains(document.activeElement)) focusComposer();
        props.onClick();
      }}
      onFocus={() => setHeldFocus(true)}
      onBlur={() => setHeldFocus(false)}
      aria-label={count ? `Scroll to end, ${count}` : "Scroll to end"}
      aria-hidden={hidden || undefined}
      inert={hidden}
      className={cn(
        floatingControl,
        floatingMotion(props.phase ?? "enter"),
        floatingHover,
        // Centred on the composer, which a pinned summary insets on the right.
        "absolute bottom-[min(calc(var(--composer-clearance,0px)+0.75rem),calc(100%-2.75rem))] left-[calc(50%-var(--summary-inset,0px)/2)] z-20 -translate-x-1/2 pr-3.5 pl-3 font-medium whitespace-nowrap text-foreground",
        "transition-[background-color,box-shadow] duration-(--motion-fast) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "touch-hit pointer-coarse:h-9",
      )}
    >
      <CaretDownIcon aria-hidden size={14} weight="bold" className="text-muted-foreground" />
      Scroll to end
      {count && (
        <span className="-mr-1 rounded-full bg-accent px-1.5 text-xs tabular-nums text-foreground">
          {count}
        </span>
      )}
    </button>
  );
}
