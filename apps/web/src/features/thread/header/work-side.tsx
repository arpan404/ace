import { Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn.ts";
import { panelMotion, usePresence } from "@/lib/motion.ts";
import { DeferredWorkCard, workSurface } from "./work-button.tsx";
import {
  workCardColumnWidth,
  workCardFitsSide,
  workCardReserve,
  useWorkCardState,
  useWorkCardStore,
} from "./work-card-store.ts";

/** The reading column's widest, when its token can't be read (tests have no layout). */
const fallbackColumn = 760;

/** The root's `--column` token: read there, since the area carries the docked override itself. */
function readColumn(): number {
  const root = globalThis.document?.documentElement;
  const raw = root ? parseFloat(getComputedStyle(root).getPropertyValue("--column")) : NaN;
  return Number.isFinite(raw) ? raw : fallbackColumn;
}

/**
 * While docked, the area publishes the card's room as inset variables and narrows the shared
 * reading column -- all inside the scrolled content, never on the scroller. The scroller keeps
 * its full width so its scrollbar stays at the thread area's far right edge, with the floating
 * card over the gutter above it (scrolling under the card at the top). The column itself
 * settles left into what is left (`column.ts` shifts it by half the reserve); the composer and
 * the pills already recenter on `--summary-inset`, which the docked card borrows here so they
 * follow with no re-renders. Nothing here takes `--summary-inset` today; if a pinned summary
 * ever does, the two insets must sum instead of sharing one variable.
 */
function applyDocked(area: HTMLElement, areaWidth: number, column: number): void {
  area.setAttribute("data-work-docked", "");
  area.style.setProperty("--column", `${workCardColumnWidth(areaWidth, column)}px`);
  area.style.setProperty("--work-reserve", `${workCardReserve}px`);
  area.style.setProperty("--summary-inset", `${workCardReserve}px`);
}

/** Closed or popover: the area reads exactly as without the card. */
function clearDocked(area: HTMLElement): void {
  area.removeAttribute("data-work-docked");
  area.style.removeProperty("--column");
  area.style.removeProperty("--work-reserve");
  area.style.removeProperty("--summary-inset");
}

/** Another layer's own Escape (a menu or form opened from the card) closes that layer only. */
const ownEscape = '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]';

/**
 * The thread area's Work slot, first in the area so Tab reaches it straight after the header.
 * It measures the area, telling the store whether the card fits beside the reading column;
 * when it does, an open card docks at the area's top right and the column makes room for it:
 * the area narrows its `--column` override down to the docked minimum and publishes the
 * card's room as inset variables, so the transcript and the composer (both on the reading
 * column) narrow together, settle left, and stay aligned. The scroller itself keeps its full
 * width: its scrollbar stays at the area's far right edge and no padding or border lands
 * beside the card. Closed, the area is exactly as without the card. Its height stops short
 * of the composer. Opening it moves focus in; Escape anywhere closes it and focus goes back
 * to the details icon.
 *
 * The column change is a plain layout pass, not an animation: the card itself arrives on the
 * existing panel motion (`fx-panel-in`), which already respects reduced motion. The transcript
 * keeps the reader's place through the width change the way it does through any resize: a
 * reader at the live end glides back to it (`useStayPinned`), otherwise the held row holds
 * still while rows above it re-measure (`scroll-mode.ts` compensation).
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
      // The token lives on the root: the area carries the docked `--column` override itself.
      const column = readColumn();
      const width = element.getBoundingClientRect().width;
      store.setSide(workCardFitsSide(width, column));
      const state = store.get();
      const host = element.parentElement;
      if (!host) return;
      if (state.open && state.side) applyDocked(host, width, column);
      else clearDocked(host);
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
  // Opening or closing without a resize still reserves or releases the column's room. A resize
  // while docked is handled in the measure above, which rewrites the narrowed width directly so
  // the transcript never re-renders for it.
  useLayoutEffect(() => {
    const area = probe.current?.parentElement ?? null;
    if (!area || !store) return;
    if (!shown) {
      clearDocked(area);
      return;
    }
    const width = probe.current?.getBoundingClientRect().width ?? 0;
    applyDocked(area, width, readColumn());
  }, [shown, store]);
  // Once opened, the card stays mounted while hidden: a form it opened outlives the card.
  const [opened, setOpened] = useState(false);
  if (shown && !opened) setOpened(true);
  useEffect(() => {
    const element = card.current;
    if (!shown || !element || !store) return;
    element.focus({ preventScroll: true });
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
