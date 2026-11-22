import { Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn.ts";
import { panelMotion, usePresence } from "@/lib/motion.ts";
import { DeferredWorkCard, workSurface } from "./work-surface.ts";
import { workCardFitsSide, useWorkCardState, useWorkCardStore } from "./work-card-store.ts";

/** The reading column's widest, when its token can't be read (tests have no layout). */
const fallbackColumn = 760;

/** The root's `--column` token. */
function readColumn(): number {
  const root = globalThis.document?.documentElement;
  const raw = root ? parseFloat(getComputedStyle(root).getPropertyValue("--column")) : NaN;
  return Number.isFinite(raw) ? raw : fallbackColumn;
}

/** Another layer's own Escape (a menu or form opened from the card) closes that layer only. */
const ownEscape = '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]';

/**
 * The thread area's Work slot, first in the area so Tab reaches it straight after the header.
 * It measures the area, telling the store whether the card fits beside the reading column; when
 * it does, an open card floats at the area's top right, over the gutter and the column's edge.
 * It never moves the column: the transcript and the composer stay exactly where they were, and
 * the transcript scrolls under the card. Its height stops short of the composer. Opening it
 * moves focus in; Escape anywhere closes it and focus goes back to the details icon.
 */
export function WorkSide(props: { threadId: string }) {
  const store = useWorkCardStore();
  const { open, side } = useWorkCardState(store);
  const probe = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = probe.current;
    const area = element?.parentElement ?? null;
    if (!element || !store) return;
    store.attachArea(area);
    if (typeof ResizeObserver === "undefined") return () => store.attachArea(null);
    const measure = () => {
      store.setSide(workCardFitsSide(element.getBoundingClientRect().width, readColumn()));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      store.attachArea(null);
    };
  }, [store]);
  const shown = open && side;
  const presence = usePresence(shown);
  // Once opened, the card stays mounted while hidden: a form it opened outlives the card.
  const [opened, setOpened] = useState(false);
  if (shown && !opened) setOpened(true);
  useEffect(() => {
    const element = card.current;
    if (!shown || !element || !store) return;
    // Only an open the person asked for moves focus; a remembered or synced card leaves it.
    if (store.takeFocus()) element.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof Element && target.closest(ownEscape) && !element.contains(target))
        return;
      event.preventDefault();
      store.setOpen(false);
      store.button()?.focus();
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("keydown", escape);
      // Closed from inside (a row that opened a tab, say): focus mustn't fall to the page.
      if (element.contains(document.activeElement)) store.button()?.focus();
    };
  }, [shown, store]);
  return (
    <>
      <div ref={probe} aria-hidden className="pointer-events-none invisible absolute inset-0" />
      {opened && (
        <div
          ref={card}
          role="dialog"
          aria-label="Thread details"
          tabIndex={-1}
          data-edge="right"
          hidden={!presence.mounted}
          className={cn(
            workSurface,
            "absolute top-3 right-3 z-20 max-h-[calc(100%-var(--composer-clearance,0px)-24px)] outline-none",
            panelMotion(presence),
          )}
        >
          <Suspense fallback={null}>
            <DeferredWorkCard.Component
              threadId={props.threadId}
              onClose={() => store?.setOpen(false)}
            />
          </Suspense>
        </div>
      )}
    </>
  );
}
