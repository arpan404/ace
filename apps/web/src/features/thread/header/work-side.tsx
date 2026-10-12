import { Suspense, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn.ts";
import { panelMotion, usePresence } from "@/lib/motion.ts";
import { DeferredWorkCard, workSurface } from "./work-button.tsx";
import { workCardFitsSide, useWorkCardState, useWorkCardStore } from "./work-card-store.ts";

/** The reading column's widest, when its token can't be read (tests have no layout). */
const fallbackColumn = 760;

/**
 * The thread area's Work slot. It measures the area, telling the store whether the card fits
 * beside the centred reading column; when it does, an open card floats at the area's top right
 * over the gutter, so the transcript never reflows. Its height stops short of the composer.
 */
export function WorkSide(props: { threadId: string }) {
  const store = useWorkCardStore();
  const { open, side } = useWorkCardState(store);
  const probe = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = probe.current;
    if (!element || !store || typeof ResizeObserver === "undefined") return;
    const column = parseFloat(getComputedStyle(element).getPropertyValue("--column"));
    const measure = () =>
      store.setSide(
        workCardFitsSide(
          element.getBoundingClientRect().width,
          Number.isFinite(column) ? column : fallbackColumn,
        ),
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [store]);
  const shown = open && side;
  const presence = usePresence(shown);
  // Once opened, the card stays mounted while hidden: a form it opened outlives the card.
  const [opened, setOpened] = useState(false);
  if (shown && !opened) setOpened(true);
  const close = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    store?.setOpen(false);
    document.querySelector<HTMLElement>("[data-work-button]")?.focus();
  };
  return (
    <>
      <div ref={probe} aria-hidden className="pointer-events-none invisible absolute inset-0" />
      {opened && (
        <div
          role="dialog"
          aria-label="Work"
          data-edge="right"
          hidden={!presence.mounted}
          onKeyDown={close}
          className={cn(
            workSurface,
            "absolute top-3 right-3 z-20 max-h-[calc(100%-var(--composer-clearance,0px)-24px)]",
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
