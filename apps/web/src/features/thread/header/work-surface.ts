import { deferredComponent } from "@/lib/deferred-component.tsx";

/** The card's groups load on first open, off the thread route's first paint. */
export const DeferredWorkCard = deferredComponent(() =>
  import("./work-card.tsx").then((module) => module.WorkCard),
);

/** The icon's popover around the card, loaded with it (`work-popover.tsx`). */
export const DeferredWorkPopover = deferredComponent(() =>
  Promise.all([import("./work-popover.tsx"), DeferredWorkCard.preload()]).then(
    ([module]) => module.WorkPopover,
  ),
);

/**
 * The floating surface both placements share: solid, 280px, as tall as its content. It holds the
 * thread's facts and controls, which are content, so it is never glass.
 */
export const workSurface =
  "ace-floating-solid w-[280px] overflow-x-hidden overflow-y-auto overscroll-contain rounded-popup border border-border bg-popover text-popover-foreground shadow-glass";
