import { useLayoutEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import {
  attachedCardPadding,
  attachedInset,
  attachedOverlap,
  attachedStripCardPadding,
  attachedSurface,
} from "./composer-styles.ts";

/**
 * The composer's one strip: a floating surface above it, a little narrower, its bottom tucked
 * behind the composer's top edge. When what it shows changes (`slot`), the new content fades in
 * while the surface eases to its height; under reduced motion it only fades. Its first content
 * takes its height at once, however late its parts arrive, so a thread opening on a request
 * never grows the strip (lifting the transcript) after its first paint. Content taller than
 * half the window scrolls inside it. One-line content (the queue, the connection, the plan)
 * sits on dense 12px rows; a request keeps a card's padding.
 */
export function StripSurface(props: { slot: string; children: ReactNode }) {
  const body = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  // The body follows its content's height through the style alone, so a change of height
  // never renders the strip again.
  useLayoutEffect(() => {
    const outer = body.current;
    const inner = content.current;
    if (!outer || !inner) return;
    const measure = () => outer.style.setProperty("height", `${inner.offsetHeight}px`);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);
  // Only a change of what the slot shows eases the height; the strip arriving never does.
  const shown = useRef(props.slot);
  useLayoutEffect(() => {
    const outer = body.current;
    if (!outer || shown.current === props.slot) return;
    shown.current = props.slot;
    outer.setAttribute("data-easing", "");
    const eased = (event: TransitionEvent) => {
      if (event.target === outer && event.propertyName === "height")
        outer.removeAttribute("data-easing");
    };
    outer.addEventListener("transitionend", eased);
    outer.addEventListener("transitioncancel", eased);
    return () => {
      outer.removeEventListener("transitionend", eased);
      outer.removeEventListener("transitioncancel", eased);
    };
  }, [props.slot]);
  return (
    <div data-composer-strip className={cn("relative z-0", attachedInset, attachedOverlap)}>
      {/* It rises from behind the composer when it first arrives. */}
      <div data-edge="bottom" className={cn("fx-panel-in relative", attachedSurface)}>
        <div ref={body} className="composer-strip-body">
          <div
            ref={content}
            className={cn(
              "max-h-[50vh] overflow-y-auto overscroll-contain",
              // A request card keeps its room for its buttons; the one-line rows are dense.
              props.slot === "request"
                ? cn("px-2 pt-1.5", attachedCardPadding)
                : cn("px-1.5 pt-1", attachedStripCardPadding),
            )}
          >
            <div key={props.slot} data-slot-kind={props.slot} className="composer-strip-swap">
              {props.children}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
